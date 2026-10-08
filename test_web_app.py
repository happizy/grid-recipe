from __future__ import annotations

import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from grid_recipe import RendererUnavailable
from web_app import create_app


SIMPLE_RECIPE = {
    "title": "Soupe à l’oignon",
    "pre_cooking": ["Sortir une casserole"],
    "flow": {
        "step": "Servir",
        "inputs": [
            {
                "step": "Mijoter 10 minutes",
                "inputs": [
                    {"amount": "500 ml", "name": "bouillon"},
                    {"amount": "1", "name": "oignon"},
                ],
            }
        ],
    },
}


class WebAppTests(unittest.TestCase):
    def setUp(self) -> None:
        self.web_dist = tempfile.TemporaryDirectory()
        Path(self.web_dist.name, "index.html").write_text(
            "<!doctype html><title>Grid Recipe</title><main>Éditeur de graphe</main>",
            encoding="utf-8",
        )
        app = create_app(
            {
                "TESTING": True,
                "RENDER_TIMEOUT_SECONDS": 5,
                "WEB_DIST_DIR": self.web_dist.name,
            }
        )
        self.client = app.test_client()

    def tearDown(self) -> None:
        self.web_dist.cleanup()

    def test_serves_the_editor_with_security_headers(self) -> None:
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"diteur de graphe", response.data)
        self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        response.close()

    def test_rejects_invalid_recipe_with_a_json_error(self) -> None:
        response = self.client.post(
            "/api/render",
            json={"recipe": {"title": "Broken", "flow": {"name": "salt"}}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("doit être une étape", response.get_json()["error"])

    def test_rejects_render_options_outside_the_public_range(self) -> None:
        response = self.client.post(
            "/api/render",
            json={"recipe": SIMPLE_RECIPE, "width_mm": 40, "ppi": 144},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("80", response.get_json()["error"])

    def test_rejects_an_excessively_deep_tree(self) -> None:
        node: dict[str, object] = {"name": "ingredient"}
        for index in range(41):
            node = {"step": f"Step {index}", "inputs": [node]}
        response = self.client.post(
            "/api/render",
            json={"recipe": {"title": "Deep", "flow": node}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("40 niveaux", response.get_json()["error"])

    def test_maps_an_unavailable_renderer_to_503(self) -> None:
        with patch(
            "web_app.render_recipe",
            side_effect=RendererUnavailable("Typst indisponible"),
        ):
            response = self.client.post(
                "/api/render",
                json={"recipe": SIMPLE_RECIPE, "width_mm": 280, "ppi": 144},
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json(), {"error": "Typst indisponible"})

    @unittest.skipUnless(shutil.which("typst"), "Typst is not installed")
    def test_renders_a_png_through_the_api(self) -> None:
        response = self.client.post(
            "/api/render",
            json={"recipe": SIMPLE_RECIPE, "width_mm": 120, "ppi": 72},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/png")
        self.assertEqual(response.data[:8], b"\x89PNG\r\n\x1a\n")
        width, height = struct.unpack(">II", response.data[16:24])
        self.assertGreater(width, 300)
        self.assertGreater(height, 100)
        self.assertIn("soupe-a-l-oignon.png", response.headers["Content-Disposition"])

    @unittest.skipUnless(shutil.which("typst"), "Typst is not installed")
    def test_health_checks_typst_and_alegreya(self) -> None:
        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")
        self.assertTrue(response.get_json()["alegreya"])


if __name__ == "__main__":
    unittest.main()
