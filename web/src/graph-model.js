export const NODE_WIDTH = 260;
export const INGREDIENT_HEIGHT = 126;
export const ACTION_HEIGHT = 132;
export const COLUMN_GAP = 360;
export const ROW_GAP = 174;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireText(value, path, allowEmpty = false) {
  if (typeof value !== "string") {
    throw new Error(`${path} doit être une chaîne de caractères`);
  }
  if (!allowEmpty && value.trim() === "") {
    throw new Error(`${path} ne doit pas être vide`);
  }
}

function rejectUnknown(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${path} contient des champs inconnus : ${unknown.join(", ")}`);
  }
}

function validateRecipeNode(node, path) {
  if (!isObject(node)) throw new Error(`${path} doit être un objet`);
  const action = "step" in node || "inputs" in node;
  const ingredient = "name" in node || "amount" in node;
  if (action && ingredient) {
    throw new Error(`${path} mélange une étape et un ingrédient`);
  }
  if (action) {
    rejectUnknown(node, ["step", "inputs"], path);
    requireText(node.step, `${path}.step`);
    if (!Array.isArray(node.inputs) || node.inputs.length === 0) {
      throw new Error(`${path}.inputs doit contenir au moins un nœud`);
    }
    node.inputs.forEach((child, index) => validateRecipeNode(child, `${path}.inputs[${index}]`));
    return "action";
  }
  rejectUnknown(node, ["name", "amount"], path);
  requireText(node.name, `${path}.name`);
  if ("amount" in node) requireText(node.amount, `${path}.amount`, true);
  return "ingredient";
}

export function validateRecipeDocument(recipe) {
  if (!isObject(recipe)) throw new Error("recipe doit être un objet");
  rejectUnknown(recipe, ["title", "pre_cooking", "flow"], "recipe");
  requireText(recipe.title, "recipe.title");
  const preCooking = recipe.pre_cooking ?? [];
  if (!Array.isArray(preCooking)) {
    throw new Error("recipe.pre_cooking doit être un tableau");
  }
  preCooking.forEach((line, index) => requireText(line, `recipe.pre_cooking[${index}]`));
  if (validateRecipeNode(recipe.flow, "recipe.flow") !== "action") {
    throw new Error("recipe.flow doit être une étape");
  }
}

function defaultIdFactory() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function recipeToGraph(recipe, makeId = defaultIdFactory) {
  validateRecipeDocument(recipe);
  const nodes = [];
  const edges = [];

  function visit(node, parentId = null, order = 0) {
    const id = makeId();
    const type = "step" in node ? "action" : "ingredient";
    nodes.push({
      id,
      type,
      position: { x: 0, y: 0 },
      data: type === "action"
        ? { step: node.step }
        : { name: node.name, amount: node.amount ?? "" },
    });
    if (parentId !== null) {
      edges.push({
        id: `edge-${id}-${parentId}`,
        source: id,
        target: parentId,
        sourceHandle: "out",
        targetHandle: "in",
        data: { order },
      });
    }
    if (type === "action") {
      node.inputs.forEach((child, index) => visit(child, id, index));
    }
    return id;
  }

  const rootId = visit(recipe.flow);
  return {
    nodes: layoutGraph(nodes, edges, rootId),
    edges,
    rootId,
    meta: {
      title: recipe.title,
      pre_cooking: [...(recipe.pre_cooking ?? [])],
    },
  };
}

function nodeLabel(node) {
  return node.type === "action" ? node.data.step || "Étape sans nom" : node.data.name || "Ingrédient sans nom";
}

function edgeOrder(edge) {
  return Number.isFinite(edge.data?.order) ? edge.data.order : Number.MAX_SAFE_INTEGER;
}

export function validateGraph(nodes, edges, meta) {
  if (!meta || typeof meta.title !== "string" || meta.title.trim() === "") {
    return { ok: false, error: "Le titre de la recette est vide." };
  }
  if (!Array.isArray(meta.pre_cooking) || meta.pre_cooking.some((line) => typeof line !== "string" || line.trim() === "")) {
    return { ok: false, error: "Une instruction préalable est vide." };
  }
  if (nodes.length === 0) {
    return { ok: false, error: "Le graphe ne contient aucun nœud." };
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) {
    return { ok: false, error: "Deux nœuds utilisent le même identifiant." };
  }
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const edgeKeys = new Set();

  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      return { ok: false, error: "Une connexion pointe vers un nœud supprimé." };
    }
    if (source.id === target.id) {
      return { ok: false, error: `« ${nodeLabel(source)} » ne peut pas se connecter à lui-même.` };
    }
    if (target.type !== "action") {
      return { ok: false, error: "Une connexion doit toujours arriver sur une étape." };
    }
    const key = `${edge.source}->${edge.target}`;
    if (edgeKeys.has(key)) {
      return { ok: false, error: "Une connexion est présente deux fois." };
    }
    edgeKeys.add(key);
    outgoing.get(edge.source).push(edge);
    incoming.get(edge.target).push(edge);
  }

  for (const node of nodes) {
    if (node.type !== "ingredient" && node.type !== "action") {
      return { ok: false, error: "Le graphe contient un type de nœud inconnu." };
    }
    if (node.type === "ingredient") {
      if (typeof node.data?.name !== "string" || node.data.name.trim() === "") {
        return { ok: false, error: "Un ingrédient ne possède pas de nom." };
      }
      if (typeof (node.data.amount ?? "") !== "string") {
        return { ok: false, error: `La quantité de « ${nodeLabel(node)} » est invalide.` };
      }
    }
    if (node.type === "action" && (typeof node.data?.step !== "string" || node.data.step.trim() === "")) {
      return { ok: false, error: "Une étape ne possède pas d’instruction." };
    }
    if (outgoing.get(node.id).length > 1) {
      return { ok: false, error: `« ${nodeLabel(node)} » alimente plusieurs étapes.` };
    }
    if (node.type === "ingredient" && incoming.get(node.id).length > 0) {
      return { ok: false, error: `L’ingrédient « ${nodeLabel(node)} » ne peut pas recevoir d’entrée.` };
    }
    if (node.type === "action" && incoming.get(node.id).length === 0) {
      return { ok: false, error: `L’étape « ${nodeLabel(node)} » ne possède aucune entrée.` };
    }
  }

  const roots = nodes.filter((node) => outgoing.get(node.id).length === 0);
  if (roots.length !== 1) {
    return {
      ok: false,
      error: roots.length === 0
        ? "Le graphe ne possède aucune étape finale ; une boucle est probablement présente."
        : `Le graphe possède ${roots.length} sorties finales au lieu d’une seule.`,
    };
  }
  const [root] = roots;
  if (root.type !== "action") {
    return { ok: false, error: "La sortie finale doit être une étape." };
  }

  for (const node of nodes) {
    const visited = new Set();
    let current = node;
    while (current.id !== root.id) {
      if (visited.has(current.id)) {
        return { ok: false, error: "Le graphe contient une boucle." };
      }
      visited.add(current.id);
      const [nextEdge] = outgoing.get(current.id);
      if (!nextEdge) {
        return { ok: false, error: `« ${nodeLabel(node)} » n’est pas relié à l’étape finale.` };
      }
      current = byId.get(nextEdge.target);
    }
  }

  return { ok: true, rootId: root.id, incoming, outgoing, byId };
}

export function graphToRecipe(nodes, edges, meta) {
  const validation = validateGraph(nodes, edges, meta);
  if (!validation.ok) return validation;
  const { rootId, incoming, byId } = validation;

  function build(nodeId) {
    const node = byId.get(nodeId);
    if (node.type === "ingredient") {
      const ingredient = { name: node.data.name ?? "" };
      if ((node.data.amount ?? "").trim() !== "") {
        ingredient.amount = node.data.amount;
      }
      return ingredient;
    }
    const inputs = [...incoming.get(nodeId)]
      .sort((left, right) => {
        const yDifference = byId.get(left.source).position.y - byId.get(right.source).position.y;
        return yDifference || edgeOrder(left) - edgeOrder(right);
      })
      .map((edge) => build(edge.source));
    return { step: node.data.step ?? "", inputs };
  }

  return {
    ok: true,
    rootId,
    recipe: {
      title: meta.title,
      pre_cooking: [...meta.pre_cooking],
      flow: build(rootId),
    },
  };
}

export function layoutGraph(nodes, edges, rootId = null) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    incoming.get(edge.target).push(edge);
    outgoing.get(edge.source).push(edge);
  }
  const root = rootId && byId.has(rootId)
    ? rootId
    : nodes.find((node) => outgoing.get(node.id).length === 0 && node.type === "action")?.id;
  if (!root) return nodes;

  let leafIndex = 0;
  const positions = new Map();
  const visiting = new Set();

  function place(nodeId) {
    if (positions.has(nodeId)) return positions.get(nodeId);
    if (visiting.has(nodeId)) return { depth: 0, centerY: leafIndex++ * ROW_GAP };
    visiting.add(nodeId);
    const node = byId.get(nodeId);
    const children = [...incoming.get(nodeId)]
      .sort((left, right) => edgeOrder(left) - edgeOrder(right))
      .map((edge) => edge.source);
    let depth = 0;
    let centerY;
    if (node.type === "ingredient" || children.length === 0) {
      centerY = leafIndex++ * ROW_GAP;
    } else {
      const childPositions = children.map(place);
      depth = Math.max(...childPositions.map((position) => position.depth)) + 1;
      centerY = (childPositions[0].centerY + childPositions[childPositions.length - 1].centerY) / 2;
    }
    const result = { depth, centerY };
    positions.set(nodeId, result);
    visiting.delete(nodeId);
    return result;
  }

  place(root);
  return nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position) return node;
    const height = node.type === "ingredient" ? INGREDIENT_HEIGHT : ACTION_HEIGHT;
    return {
      ...node,
      position: {
        x: position.depth * COLUMN_GAP,
        y: position.centerY - height / 2,
      },
    };
  });
}

export function wouldCreateCycle(nodes, edges, sourceId, targetId) {
  if (sourceId === targetId) return true;
  const outgoing = new Map();
  for (const edge of edges) {
    if (edge.source !== sourceId) outgoing.set(edge.source, edge.target);
  }
  outgoing.set(sourceId, targetId);
  const visited = new Set();
  let current = targetId;
  while (outgoing.has(current)) {
    if (current === sourceId || visited.has(current)) return true;
    visited.add(current);
    current = outgoing.get(current);
  }
  return current === sourceId;
}

export function canConnect(nodes, edges, connection) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const source = byId.get(connection.source);
  const target = byId.get(connection.target);
  return Boolean(
    source
    && target
    && target.type === "action"
    && source.id !== target.id
    && !wouldCreateCycle(nodes, edges, source.id, target.id)
  );
}

export function connectOrReparent(edges, connection, makeId = defaultIdFactory) {
  const retained = edges.filter((edge) => edge.source !== connection.source);
  const siblingOrders = retained
    .filter((edge) => edge.target === connection.target)
    .map(edgeOrder)
    .filter(Number.isFinite);
  const order = siblingOrders.length ? Math.max(...siblingOrders) + 1 : 0;
  return [
    ...retained,
    {
      id: `edge-${makeId()}`,
      source: connection.source,
      target: connection.target,
      sourceHandle: "out",
      targetHandle: "in",
      data: { order },
    },
  ];
}
