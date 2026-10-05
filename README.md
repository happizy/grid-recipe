# Grid Recipe

`grid_recipe.py` turns a recipe dependency tree into a Michael Chu-style recipe
table. It writes readable Typst source and uses Typst to render the table as a
single PNG with a fixed width and automatic height.

The script uses only Python's standard library. It requires Python 3.10 or newer,
the [`typst`](https://github.com/typst/typst) command on `PATH`, and the Alegreya
font installed where Typst can find it.

## Render the example

```sh
python3 grid_recipe.py example_recipe.json
```

This creates `example_recipe.typ` and `example_recipe.png`. To choose another
location or change the physical width and raster density:

```sh
python3 grid_recipe.py recipe.json -o build/recipe.png --width-mm 240 --ppi 192
```

The default width is 280 mm and the default PNG density is 144 PPI. The page
height grows to fit the recipe, so every render is a single image.

## JSON format

A recipe has a title, optional pre-cooking instructions, and one root action:

```json
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
          {"amount": "1", "name": "carrot"}
        ]
      }
    ]
  }
}
```

There are two node types:

- An ingredient has a required `name` and an optional `amount`.
- An action has a `step` and a nonempty `inputs` array containing ingredients or
  earlier actions.

At every merge, the deepest preparation branch appears first; equal-depth inputs
keep their JSON order. This produces the format's characteristic staircase.
Actions are placed in the first column after all their inputs are ready, parallel
branches share columns, and each action spans all ingredient rows that feed it.
Within each ingredient cell, the bold ingredient name is left aligned and the
normal-weight quantity is right aligned. A 1em gutter separates the two columns.

The format represents a combination tree. An ingredient occurrence belongs to
one branch, and branches can combine but cannot split and later recombine. Write
separately measured portions as separate ingredient leaves.

## Tests

```sh
python3 -m unittest -v
```

The integration test is skipped when Typst is not installed.
