from __future__ import annotations

import shutil
import struct
import tempfile
import unittest
from pathlib import Path

from grid_recipe import (
    Action,
    Ingredient,
    RecipeError,
    build_layout,
    generate_typst,
    parse_recipe,
    render_recipe,
)


class ParseRecipeTests(unittest.TestCase):
    def test_parses_optional_amount_and_pre_cooking(self) -> None:
        recipe = parse_recipe(
            {
                "title": "Toast",
                "flow": {
                    "step": "Serve",
                    "inputs": [{"name": "salt"}],
                },
            }
        )
        self.assertEqual(recipe.title, "Toast")
        self.assertEqual(recipe.pre_cooking, ())
        self.assertEqual(recipe.flow.inputs[0], Ingredient(name="salt", amount=""))

    def test_reports_nested_path_for_invalid_node(self) -> None:
        with self.assertRaisesRegex(
            RecipeError, r"recipe\.flow\.inputs\[0\] cannot mix"
        ):
            parse_recipe(
                {
                    "title": "Broken",
                    "flow": {
                        "step": "Cook",
                        "inputs": [{"name": "rice", "step": "rinse"}],
                    },
                }
            )

    def test_rejects_unknown_fields(self) -> None:
        with self.assertRaisesRegex(RecipeError, "unknown field"):
            parse_recipe(
                {
                    "title": "Broken",
                    "servings": 2,
                    "flow": {
                        "step": "Cook",
                        "inputs": [{"name": "rice"}],
                    },
                }
            )

    def test_requires_action_at_root(self) -> None:
        with self.assertRaisesRegex(RecipeError, "must be an action"):
            parse_recipe({"title": "Apple", "flow": {"name": "apple"}})


class LayoutTests(unittest.TestCase):
    def test_places_parallel_branches_at_the_earliest_column(self) -> None:
        flow = Action(
            "Bake",
            (
                Action(
                    "Combine",
                    (
                        Action("Melt", (Ingredient("butter", "100 g"),)),
                        Ingredient("sugar", "100 g"),
                    ),
                ),
                Action(
                    "Whisk",
                    (Ingredient("eggs", "2"), Ingredient("milk", "50 ml")),
                ),
            ),
        )
        layout = build_layout(flow)
        actions = {cell.text: cell for cell in layout.cells if cell.kind == "action"}

        self.assertEqual(layout.row_count, 4)
        self.assertEqual(layout.column_count, 4)
        self.assertEqual((actions["Melt"].column, actions["Melt"].rowspan), (1, 1))
        self.assertEqual((actions["Whisk"].column, actions["Whisk"].rowspan), (1, 2))
        self.assertEqual((actions["Combine"].column, actions["Combine"].rowspan), (2, 2))
        self.assertEqual((actions["Bake"].column, actions["Bake"].rowspan), (3, 4))

    def test_orders_deeper_branches_first_for_a_staircase(self) -> None:
        flow = Action(
            "Serve",
            (
                Ingredient("garnish"),
                Action(
                    "Cook",
                    (Action("Chop", (Ingredient("vegetable"),)),),
                ),
                Ingredient("seasoning"),
            ),
        )
        layout = build_layout(flow)
        ingredient_names = [
            cell.text for cell in layout.cells if cell.kind == "ingredient"
        ]

        self.assertEqual(ingredient_names, ["vegetable", "garnish", "seasoning"])

    def test_escapes_recipe_text_as_typst_strings(self) -> None:
        recipe = parse_recipe(
            {
                "title": 'A #recipe "with" \\ symbols',
                "pre_cooking": ["Line one\nLine two"],
                "flow": {
                    "step": "Serve [now]",
                    "inputs": [{"amount": "1", "name": "fish #1"}],
                },
            }
        )
        source = generate_typst(recipe)
        self.assertIn('font: "Alegreya"', source)
        self.assertIn("measure(strong(name)).width", source)
        self.assertIn("columns: (name-width, 1fr)", source)
        self.assertIn("column-gutter: 1em", source)
        self.assertIn("align: (left, right)", source)
        self.assertIn("strong(name),\n      amount,", source)
        self.assertIn('A #recipe \\"with\\" \\\\ symbols', source)
        self.assertIn('Line one\\nLine two', source)
        self.assertIn('fish #1', source)


@unittest.skipUnless(shutil.which("typst"), "Typst is not installed")
class TypstIntegrationTests(unittest.TestCase):
    def test_renders_typst_and_png(self) -> None:
        recipe = parse_recipe(
            {
                "title": "Simple Soup",
                "pre_cooking": ["Bring out a saucepan"],
                "flow": {
                    "step": "Serve",
                    "inputs": [
                        {
                            "step": "Simmer for 10 minutes",
                            "inputs": [
                                {"amount": "500 ml", "name": "stock"},
                                {"amount": "1", "name": "carrot"},
                            ],
                        }
                    ],
                },
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "soup.png"
            typst_path, png_path = render_recipe(
                recipe, output, width_mm=120, ppi=72
            )

            self.assertTrue(typst_path.is_file())
            self.assertGreater(png_path.stat().st_size, 100)
            with png_path.open("rb") as image:
                header = image.read(24)
            self.assertEqual(header[:8], b"\x89PNG\r\n\x1a\n")
            width, height = struct.unpack(">II", header[16:24])
            self.assertGreater(width, 300)
            self.assertGreater(height, 100)


if __name__ == "__main__":
    unittest.main()
