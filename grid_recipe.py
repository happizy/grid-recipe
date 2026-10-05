#!/usr/bin/env python3
"""Render Michael Chu-style grid recipes with Typst."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias


class RecipeError(ValueError):
    """Raised when a recipe document does not match the expected schema."""


@dataclass(frozen=True)
class Ingredient:
    name: str
    amount: str = ""


@dataclass(frozen=True)
class Action:
    step: str
    inputs: tuple["Node", ...]


Node: TypeAlias = Ingredient | Action


@dataclass(frozen=True)
class Recipe:
    title: str
    pre_cooking: tuple[str, ...]
    flow: Action


@dataclass(frozen=True)
class LayoutCell:
    row: int
    column: int
    rowspan: int
    text: str
    kind: str
    amount: str = ""


@dataclass(frozen=True)
class Layout:
    row_count: int
    column_count: int
    cells: tuple[LayoutCell, ...]


def _object(value: object, path: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise RecipeError(f"{path} must be an object")
    if not all(isinstance(key, str) for key in value):
        raise RecipeError(f"{path} must use string keys")
    return value


def _text(value: object, path: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise RecipeError(f"{path} must be a string")
    value = value.strip()
    if not allow_empty and not value:
        raise RecipeError(f"{path} must not be empty")
    return value


def _reject_unknown(data: dict[str, object], allowed: set[str], path: str) -> None:
    unknown = sorted(set(data) - allowed)
    if unknown:
        names = ", ".join(repr(name) for name in unknown)
        raise RecipeError(f"{path} contains unknown field(s): {names}")


def _parse_node(value: object, path: str) -> Node:
    data = _object(value, path)
    looks_like_action = "step" in data or "inputs" in data
    looks_like_ingredient = "name" in data or "amount" in data

    if looks_like_action and looks_like_ingredient:
        raise RecipeError(f"{path} cannot mix action and ingredient fields")

    if looks_like_action:
        _reject_unknown(data, {"step", "inputs"}, path)
        if "step" not in data:
            raise RecipeError(f"{path}.step is required")
        if "inputs" not in data:
            raise RecipeError(f"{path}.inputs is required")
        step = _text(data["step"], f"{path}.step")
        inputs_value = data["inputs"]
        if not isinstance(inputs_value, list):
            raise RecipeError(f"{path}.inputs must be an array")
        if not inputs_value:
            raise RecipeError(f"{path}.inputs must contain at least one node")
        inputs = tuple(
            _parse_node(child, f"{path}.inputs[{index}]")
            for index, child in enumerate(inputs_value)
        )
        return Action(step=step, inputs=inputs)

    _reject_unknown(data, {"name", "amount"}, path)
    if "name" not in data:
        raise RecipeError(f"{path}.name is required")
    name = _text(data["name"], f"{path}.name")
    amount = _text(data.get("amount", ""), f"{path}.amount", allow_empty=True)
    return Ingredient(name=name, amount=amount)


def parse_recipe(value: object) -> Recipe:
    data = _object(value, "recipe")
    _reject_unknown(data, {"title", "pre_cooking", "flow"}, "recipe")

    if "title" not in data:
        raise RecipeError("recipe.title is required")
    if "flow" not in data:
        raise RecipeError("recipe.flow is required")

    title = _text(data["title"], "recipe.title")
    pre_value = data.get("pre_cooking", [])
    if not isinstance(pre_value, list):
        raise RecipeError("recipe.pre_cooking must be an array")
    pre_cooking = tuple(
        _text(item, f"recipe.pre_cooking[{index}]")
        for index, item in enumerate(pre_value)
    )

    flow = _parse_node(data["flow"], "recipe.flow")
    if not isinstance(flow, Action):
        raise RecipeError("recipe.flow must be an action node")
    return Recipe(title=title, pre_cooking=pre_cooking, flow=flow)


def load_recipe(path: Path) -> Recipe:
    try:
        with path.open("r", encoding="utf-8-sig") as source:
            value = json.load(source)
    except FileNotFoundError as error:
        raise RecipeError(f"recipe file does not exist: {path}") from error
    except OSError as error:
        raise RecipeError(f"cannot read recipe file {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise RecipeError(
            f"invalid JSON in {path} at line {error.lineno}, column {error.colno}: "
            f"{error.msg}"
        ) from error
    return parse_recipe(value)


def build_layout(flow: Action) -> Layout:
    """Convert a combination tree into staircase-ordered table coordinates."""

    cells: list[LayoutCell] = []
    next_row = 0

    def depth(node: Node) -> int:
        if isinstance(node, Ingredient):
            return 0
        return max(depth(child) for child in node.inputs) + 1

    def visit(node: Node) -> tuple[int, int, int]:
        # Return (first row, number of ingredient rows, completion column).
        nonlocal next_row
        if isinstance(node, Ingredient):
            row = next_row
            next_row += 1
            cells.append(
                LayoutCell(
                    row=row,
                    column=0,
                    rowspan=1,
                    text=node.name,
                    amount=node.amount,
                    kind="ingredient",
                )
            )
            return row, 1, 0

        # Put the longest preparation branch first at every merge. Python's
        # stable sort preserves the author's order for equal-depth branches.
        ordered_inputs = sorted(node.inputs, key=depth, reverse=True)
        child_layouts = [visit(child) for child in ordered_inputs]
        first_row = child_layouts[0][0]
        rowspan = sum(child[1] for child in child_layouts)
        column = max(child[2] for child in child_layouts) + 1
        cells.append(
            LayoutCell(
                row=first_row,
                column=column,
                rowspan=rowspan,
                text=node.step,
                kind="action",
            )
        )
        return first_row, rowspan, column

    _, row_count, root_column = visit(flow)
    return Layout(
        row_count=row_count,
        column_count=root_column + 1,
        cells=tuple(cells),
    )


def typst_string(value: str) -> str:
    """Return a Typst string literal without interpreting user markup."""

    escaped: list[str] = ['"']
    replacements = {
        "\\": "\\\\",
        '"': '\\"',
        "\n": "\\n",
        "\r": "\\r",
        "\t": "\\t",
    }
    for character in value:
        if character in replacements:
            escaped.append(replacements[character])
        elif ord(character) < 0x20 or ord(character) == 0x7F:
            escaped.append(f"\\u{{{ord(character):x}}}")
        else:
            escaped.append(character)
    escaped.append('"')
    return "".join(escaped)


def _cell(
    *,
    x: int,
    y: int,
    body: str,
    fill: str,
    align: str,
    colspan: int = 1,
    rowspan: int = 1,
    inset: str = "(x: 8pt, y: 7pt)",
) -> str:
    options = [
        f"x: {x}",
        f"y: {y}",
        f"fill: {fill}",
        f"align: {align}",
        f"inset: {inset}",
    ]
    if colspan != 1:
        options.append(f"colspan: {colspan}")
    if rowspan != 1:
        options.append(f"rowspan: {rowspan}")
    rendered_options = ", ".join(options)
    return f"    table.cell({rendered_options})[{body}],"


def generate_typst(recipe: Recipe, *, width_mm: float = 280.0) -> str:
    layout = build_layout(recipe.flow)
    header_rows = 1 + len(recipe.pre_cooking)
    columns = ["34%"] + ["1fr"] * (layout.column_count - 1)
    ingredient_names = [
        typst_string(cell.text) for cell in layout.cells if cell.kind == "ingredient"
    ]
    lines = [
        "// Generated by grid_recipe.py. Edit the JSON source and render again.",
        f"#set page(width: {width_mm:g}mm, height: auto, margin: 8mm, fill: rgb(\"#f5f4ef\"))",
        '#set text(font: "Alegreya", size: 10.5pt, fill: rgb("#202820"))',
        "#set par(leading: 0.55em)",
        "",
        "#let border = rgb(\"#879287\")",
        "#let title-fill = rgb(\"#f0eee5\")",
        "#let prep-fill = rgb(\"#dff1e3\")",
        "#let ingredient-fill = rgb(\"#fffef9\")",
        "#let action-fill = rgb(\"#f7f8f3\")",
        "#let waiting-fill = rgb(\"#fbfcf8\")",
        f"#let ingredient-names = ({', '.join(ingredient_names)},)",
        "",
        "#let ingredient(amount, name) = context {",
        "  let name-width = calc.max(",
        "    ..ingredient-names.map(name => measure(strong(name)).width)",
        "  )",
        "  if amount == \"\" { strong(name) }",
        "  else {",
        "    grid(",
        "      columns: (name-width, 1fr),",
        "      column-gutter: 1em,",
        "      align: (left, right),",
        "      strong(name),",
        "      amount,",
        "    )",
        "  }",
        "}",
        "",
        "#block(",
        "  width: 100%,",
        "  fill: white,",
        "  stroke: 1pt + border,",
        "  radius: 8pt,",
        "  clip: true,",
        "  inset: 0pt,",
        ")[",
        "  #table(",
        f"    columns: ({', '.join(columns)}),",
        "    stroke: 0.55pt + border,",
    ]

    lines.append(
        _cell(
            x=0,
            y=0,
            colspan=layout.column_count,
            fill="title-fill",
            align="left + horizon",
            inset="(x: 10pt, y: 9pt)",
            body=f"#text(size: 17pt, weight: \"bold\", {typst_string(recipe.title)})",
        )
    )

    for index, instruction in enumerate(recipe.pre_cooking, start=1):
        lines.append(
            _cell(
                x=0,
                y=index,
                colspan=layout.column_count,
                fill="prep-fill",
                align="center + horizon",
                body=f"#text({typst_string(instruction)})",
            )
        )

    occupied: set[tuple[int, int]] = set()
    for cell in layout.cells:
        y = header_rows + cell.row
        if cell.kind == "ingredient":
            body = f"#ingredient({typst_string(cell.amount)}, {typst_string(cell.text)})"
            fill = "ingredient-fill"
            align = "left + horizon"
        else:
            body = f"#text({typst_string(cell.text)})"
            fill = "action-fill"
            align = "center + horizon"
        lines.append(
            _cell(
                x=cell.column,
                y=y,
                rowspan=cell.rowspan,
                fill=fill,
                align=align,
                body=body,
            )
        )
        for row in range(cell.row, cell.row + cell.rowspan):
            occupied.add((row, cell.column))

    for row in range(layout.row_count):
        for column in range(layout.column_count):
            if (row, column) not in occupied:
                lines.append(
                    _cell(
                        x=column,
                        y=header_rows + row,
                        fill="waiting-fill",
                        align="center + horizon",
                        body="",
                    )
                )

    lines.extend(["  )", "]", ""])
    return "\n".join(lines)


def render_recipe(
    recipe: Recipe,
    output_png: Path,
    *,
    width_mm: float = 280.0,
    ppi: int = 144,
    typst_binary: str = "typst",
) -> tuple[Path, Path]:
    if not math.isfinite(width_mm) or width_mm <= 0:
        raise RecipeError("page width must be greater than zero")
    if ppi <= 0:
        raise RecipeError("PPI must be greater than zero")
    if output_png.suffix.lower() != ".png":
        raise RecipeError("output path must end in .png")

    output_png = output_png.resolve()
    output_typst = output_png.with_suffix(".typ")
    source = generate_typst(recipe, width_mm=width_mm)
    try:
        output_png.parent.mkdir(parents=True, exist_ok=True)
        output_typst.write_text(source, encoding="utf-8")
    except OSError as error:
        raise RecipeError(f"cannot write {output_typst}: {error}") from error

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{output_png.stem}-",
            suffix=".png",
            dir=output_png.parent,
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)

        command = [
            typst_binary,
            "compile",
            "--ppi",
            str(ppi),
            str(output_typst),
            str(temporary_path),
        ]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "unknown Typst error"
            raise RecipeError(f"Typst compilation failed:\n{detail}")
        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            raise RecipeError("Typst completed without producing a PNG")
        os.replace(temporary_path, output_png)
        output_png.chmod(0o644)
        temporary_path = None
    except FileNotFoundError as error:
        raise RecipeError(
            f"Typst executable not found: {typst_binary!r}; install Typst or add it to PATH"
        ) from error
    except OSError as error:
        raise RecipeError(f"cannot write output PNG {output_png}: {error}") from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    return output_typst, output_png


def _positive_float(value: str) -> float:
    try:
        number = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return number


def _positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if number <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return number


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Render a Michael Chu-style grid recipe as Typst and PNG."
    )
    parser.add_argument("recipe", type=Path, help="JSON recipe file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="output PNG path (default: the JSON path with a .png suffix)",
    )
    parser.add_argument(
        "--width-mm",
        type=_positive_float,
        default=280.0,
        help="fixed page width in millimetres (default: 280)",
    )
    parser.add_argument(
        "--ppi",
        type=_positive_int,
        default=144,
        help="PNG raster density (default: 144)",
    )
    parser.add_argument(
        "--typst-bin",
        default="typst",
        help=argparse.SUPPRESS,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    output = arguments.output or arguments.recipe.with_suffix(".png")
    try:
        recipe = load_recipe(arguments.recipe)
        typst_path, png_path = render_recipe(
            recipe,
            output,
            width_mm=arguments.width_mm,
            ppi=arguments.ppi,
            typst_binary=arguments.typst_bin,
        )
    except RecipeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"Wrote {typst_path}")
    print(f"Wrote {png_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
