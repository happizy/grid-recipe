#!/usr/bin/env python3
"""HTTP interface for the grid recipe renderer."""

from __future__ import annotations

import io
import math
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_file
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge, UnsupportedMediaType

from grid_recipe import (
    RecipeError,
    RenderError,
    RendererUnavailable,
    parse_recipe,
    render_recipe,
)


MAX_REQUEST_BYTES = 256 * 1024
MAX_NODES = 500
MAX_DEPTH = 40
MAX_PRE_COOKING = 100
MAX_TEXT_LENGTH = 2_000
MIN_WIDTH_MM = 80.0
MAX_WIDTH_MM = 500.0
MIN_PPI = 72
MAX_PPI = 300


class RequestError(ValueError):
    """Raised when an HTTP request is well-formed JSON but cannot be accepted."""


def _recipe_error_fr(error: RecipeError) -> str:
    message = str(error)
    replacements = (
        (" must be an object", " doit être un objet"),
        (" must use string keys", " doit utiliser des clés textuelles"),
        (
            " cannot mix action and ingredient fields",
            " mélange les champs d’une étape et d’un ingrédient",
        ),
        (
            " contains unknown field(s):",
            " contient un ou plusieurs champs inconnus :",
        ),
        (" is required", " est obligatoire"),
        (" must be a string", " doit être une chaîne de caractères"),
        (" must not be empty", " ne doit pas être vide"),
        (" must be an array", " doit être un tableau"),
        (" must contain at least one node", " doit contenir au moins un nœud"),
        (" must be an action node", " doit être une étape"),
    )
    for source, target in replacements:
        message = message.replace(source, target)
    return message


def _render_error_fr(error: RenderError) -> str:
    message = str(error)
    if "exceeded" in message:
        return "La compilation Typst a dépassé le délai autorisé"
    if "executable not found" in message:
        return "Le compilateur Typst est introuvable sur le serveur"
    if message.startswith("Typst compilation failed:"):
        return message.replace(
            "Typst compilation failed:", "La compilation Typst a échoué :", 1
        )
    if message == "Typst completed without producing a PNG":
        return "Typst n’a produit aucune image PNG"
    return message


def _error(message: str, status: int) -> tuple[Response, int]:
    return jsonify(error=message), status


def _render_number(
    value: object,
    name: str,
    default: float,
    minimum: float,
    maximum: float,
    *,
    integer: bool = False,
) -> float | int:
    if value is None:
        value = default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RequestError(f"{name} doit être un nombre")
    if integer and (not isinstance(value, int) or isinstance(value, bool)):
        raise RequestError(f"{name} doit être un entier")
    number = float(value)
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise RequestError(f"{name} doit être compris entre {minimum:g} et {maximum:g}")
    return int(value) if integer else number


def _check_recipe_limits(value: object) -> None:
    if not isinstance(value, dict):
        raise RequestError("recipe doit être un objet JSON")

    title = value.get("title")
    if isinstance(title, str) and len(title) > MAX_TEXT_LENGTH:
        raise RequestError(f"recipe.title dépasse {MAX_TEXT_LENGTH} caractères")

    pre_cooking = value.get("pre_cooking", [])
    if isinstance(pre_cooking, list):
        if len(pre_cooking) > MAX_PRE_COOKING:
            raise RequestError(
                f"recipe.pre_cooking ne peut pas dépasser {MAX_PRE_COOKING} lignes"
            )
        for index, instruction in enumerate(pre_cooking):
            if isinstance(instruction, str) and len(instruction) > MAX_TEXT_LENGTH:
                raise RequestError(
                    f"recipe.pre_cooking[{index}] dépasse {MAX_TEXT_LENGTH} caractères"
                )

    flow = value.get("flow")
    stack: list[tuple[object, int, str]] = [(flow, 1, "recipe.flow")]
    node_count = 0
    while stack:
        node, depth, path = stack.pop()
        node_count += 1
        if node_count > MAX_NODES:
            raise RequestError(f"la recette ne peut pas dépasser {MAX_NODES} nœuds")
        if depth > MAX_DEPTH:
            raise RequestError(f"la recette ne peut pas dépasser {MAX_DEPTH} niveaux")
        if not isinstance(node, dict):
            continue
        for field in ("name", "amount", "step"):
            text = node.get(field)
            if isinstance(text, str) and len(text) > MAX_TEXT_LENGTH:
                raise RequestError(
                    f"{path}.{field} dépasse {MAX_TEXT_LENGTH} caractères"
                )
        inputs = node.get("inputs")
        if isinstance(inputs, list):
            for index in range(len(inputs) - 1, -1, -1):
                stack.append((inputs[index], depth + 1, f"{path}.inputs[{index}]"))


def _safe_filename(title: str) -> str:
    normalized = unicodedata.normalize("NFKD", title)
    normalized = re.sub(r"['’]+", " ", normalized)
    ascii_title = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_title).strip("-").lower()
    return f"{slug or 'recette'}.png"


def _renderer_health(typst_binary: str) -> tuple[dict[str, Any], int]:
    executable = shutil.which(typst_binary)
    if executable is None:
        return {"status": "error", "typst": None, "alegreya": False}, 503
    try:
        version = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        ).stdout.strip()
        fonts = subprocess.run(
            [executable, "fonts"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        ).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return {"status": "error", "typst": None, "alegreya": False}, 503
    has_alegreya = any(line.strip() == "Alegreya" for line in fonts)
    status = 200 if has_alegreya else 503
    return {
        "status": "ok" if has_alegreya else "error",
        "typst": version,
        "alegreya": has_alegreya,
    }, status


def create_app(config: dict[str, Any] | None = None) -> Flask:
    config = config or {}
    web_dist = config.get(
        "WEB_DIST_DIR",
        str(Path(__file__).resolve().parent / "web" / "dist"),
    )
    app = Flask(__name__, static_folder=web_dist, static_url_path="/static")
    app.config.from_mapping(
        MAX_CONTENT_LENGTH=MAX_REQUEST_BYTES,
        TYPST_BINARY=os.environ.get("TYPST_BIN", "typst"),
        RENDER_TIMEOUT_SECONDS=float(os.environ.get("RENDER_TIMEOUT_SECONDS", "30")),
    )
    app.config.update(config)

    @app.after_request
    def security_headers(response: Response) -> Response:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'"
        )
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.errorhandler(RequestEntityTooLarge)
    def request_too_large(_error_value: RequestEntityTooLarge) -> tuple[Response, int]:
        return _error("La requête dépasse la limite de 256 Kio", 413)

    @app.get("/")
    def index() -> Response:
        return app.send_static_file("index.html")

    @app.get("/api/health")
    def health() -> tuple[Response, int]:
        payload, status = _renderer_health(app.config["TYPST_BINARY"])
        return jsonify(payload), status

    @app.post("/api/render")
    def render() -> Response | tuple[Response, int]:
        try:
            try:
                payload = request.get_json(cache=False)
            except (BadRequest, UnsupportedMediaType, RecursionError) as error:
                raise RequestError("Le corps doit contenir un objet JSON valide") from error
            if not isinstance(payload, dict):
                raise RequestError("Le corps doit contenir un objet JSON")
            unknown = sorted(set(payload) - {"recipe", "width_mm", "ppi"})
            if unknown:
                raise RequestError(
                    "Champ(s) de requête inconnu(s) : " + ", ".join(unknown)
                )
            if "recipe" not in payload:
                raise RequestError("Le champ recipe est obligatoire")

            width_mm = _render_number(
                payload.get("width_mm"),
                "width_mm",
                280.0,
                MIN_WIDTH_MM,
                MAX_WIDTH_MM,
            )
            ppi = _render_number(
                payload.get("ppi"),
                "ppi",
                144,
                MIN_PPI,
                MAX_PPI,
                integer=True,
            )
            raw_recipe = payload["recipe"]
            _check_recipe_limits(raw_recipe)
            recipe = parse_recipe(raw_recipe)

            with tempfile.TemporaryDirectory(prefix="grid-recipe-") as directory:
                output = Path(directory) / "recipe.png"
                render_recipe(
                    recipe,
                    output,
                    width_mm=float(width_mm),
                    ppi=int(ppi),
                    typst_binary=app.config["TYPST_BINARY"],
                    timeout_seconds=float(app.config["RENDER_TIMEOUT_SECONDS"]),
                )
                image = output.read_bytes()

            return send_file(
                io.BytesIO(image),
                mimetype="image/png",
                as_attachment=False,
                download_name=_safe_filename(recipe.title),
                max_age=0,
            )
        except RequestError as error:
            return _error(str(error), 400)
        except RecipeError as error:
            return _error(_recipe_error_fr(error), 400)
        except RendererUnavailable as error:
            return _error(_render_error_fr(error), 503)
        except RenderError as error:
            app.logger.exception("Typst compilation failed")
            return _error(_render_error_fr(error), 500)

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=False)
