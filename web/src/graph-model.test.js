import { describe, expect, it } from "vitest";
import {
  canConnect,
  connectOrReparent,
  graphToRecipe,
  recipeToGraph,
  validateGraph,
} from "./graph-model.js";

const RECIPE = {
  title: "Soupe",
  pre_cooking: ["Pour 2 personnes"],
  flow: {
    step: "Servir",
    inputs: [
      {
        step: "Mijoter",
        inputs: [
          { amount: "500 ml", name: "bouillon" },
          { name: "poivre" },
        ],
      },
      { amount: "2", name: "bols" },
    ],
  },
};

function ids() {
  let index = 0;
  return () => `n${index++}`;
}

describe("conversion recette et graphe", () => {
  it("conserve le document et omet les quantités vides", () => {
    const graph = recipeToGraph(RECIPE, ids());
    const result = graphToRecipe(graph.nodes, graph.edges, graph.meta);

    expect(result.ok).toBe(true);
    expect(result.recipe).toEqual(RECIPE);
    expect(graph.edges.every((edge) => edge.sourceHandle === "out" && edge.targetHandle === "in")).toBe(true);
  });

  it("utilise la position verticale pour ordonner les entrées", () => {
    const graph = recipeToGraph(RECIPE, ids());
    const root = graph.rootId;
    const rootInputs = graph.edges.filter((edge) => edge.target === root);
    const [first, second] = rootInputs;
    const moved = graph.nodes.map((node) => {
      if (node.id === first.source) return { ...node, position: { ...node.position, y: 500 } };
      if (node.id === second.source) return { ...node, position: { ...node.position, y: 0 } };
      return node;
    });

    const result = graphToRecipe(moved, graph.edges, graph.meta);
    expect(result.recipe.flow.inputs[0].name).toBe("bols");
  });

  it("place les ingrédients à gauche de l’étape finale", () => {
    const graph = recipeToGraph(RECIPE, ids());
    const root = graph.nodes.find((node) => node.id === graph.rootId);
    const ingredients = graph.nodes.filter((node) => node.type === "ingredient");

    expect(Math.min(...ingredients.map((node) => node.position.x))).toBe(0);
    expect(ingredients.every((node) => node.position.x < root.position.x)).toBe(true);
  });
});

describe("contraintes du graphe", () => {
  it("refuse un brouillon avec plusieurs sorties finales", () => {
    const graph = recipeToGraph(RECIPE, ids());
    const result = validateGraph([
      ...graph.nodes,
      { id: "orphan", type: "ingredient", position: { x: 0, y: 0 }, data: { name: "sel", amount: "" } },
    ], graph.edges, graph.meta);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("sorties finales");
  });

  it("refuse une étape sans entrée", () => {
    const nodes = [{ id: "step", type: "action", position: { x: 0, y: 0 }, data: { step: "Servir" } }];
    expect(validateGraph(nodes, [], { title: "Test", pre_cooking: [] }).error).toContain("aucune entrée");
  });

  it("refuse les libellés vides avant le rendu", () => {
    const graph = recipeToGraph(RECIPE, ids());
    const ingredient = graph.nodes.find((node) => node.type === "ingredient");
    const nodes = graph.nodes.map((node) => node.id === ingredient.id
      ? { ...node, data: { ...node.data, name: " " } }
      : node);

    expect(validateGraph(nodes, graph.edges, graph.meta).error).toContain("pas de nom");
  });

  it("empêche les boucles et les connexions vers un ingrédient", () => {
    const graph = recipeToGraph(RECIPE, ids());
    const nested = graph.nodes.find((node) => node.type === "action" && node.id !== graph.rootId);
    const ingredient = graph.nodes.find((node) => node.type === "ingredient");

    expect(canConnect(graph.nodes, graph.edges, { source: graph.rootId, target: nested.id })).toBe(false);
    expect(canConnect(graph.nodes, graph.edges, { source: nested.id, target: ingredient.id })).toBe(false);
  });

  it("déplace une sortie existante lors d’un nouveau raccordement", () => {
    const edges = [{ id: "old", source: "ingredient", target: "step-a", data: { order: 0 } }];
    const result = connectOrReparent(edges, { source: "ingredient", target: "step-b" }, () => "new");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "edge-new", source: "ingredient", target: "step-b" });
  });
});
