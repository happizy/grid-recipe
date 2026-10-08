import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from "@xyflow/react";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canConnect,
  connectOrReparent,
  graphToRecipe,
  layoutGraph,
  recipeToGraph,
  validateRecipeDocument,
} from "./graph-model.js";

const INITIAL_RECIPE = {
  title: "Somen froids",
  pre_cooking: ["Quantités pour 1 personne"],
  flow: {
    step: "Dresser le bol",
    inputs: [
      {
        step: "Mélanger et servir froid",
        inputs: [
          { amount: "100 ml", name: "tsuyu froid" },
          { amount: "200 ml", name: "eau" },
          { name: "glaçons" },
        ],
      },
      { step: "Cuire puis refroidir", inputs: [{ amount: "1 fagot", name: "somen" }] },
      { name: "œuf mariné" },
      { name: "sésame" },
    ],
  },
};

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function IngredientNode({ id, data, selected }) {
  return (
    <article className={`graph-node ingredient-node${selected ? " selected" : ""}`}>
      <div className="node-heading">
        <span className="node-kind">Ingrédient</span>
        <button className="node-delete nodrag" type="button" onClick={() => data.onDelete(id)} aria-label="Supprimer l’ingrédient">×</button>
      </div>
      <label>Nom
        <input className="nodrag nowheel" value={data.name} onChange={(event) => data.onChange(id, "name", event.target.value)} placeholder="Ex. tomates" />
      </label>
      <label>Quantité <span>(facultative)</span>
        <input className="nodrag nowheel" value={data.amount} onChange={(event) => data.onChange(id, "amount", event.target.value)} placeholder="Ex. 250 g" />
      </label>
      <Handle id="out" type="source" position={Position.Right} className="node-handle output-handle" />
    </article>
  );
}

function ActionNode({ id, data, selected }) {
  return (
    <article className={`graph-node action-node${selected ? " selected" : ""}${data.isFinal ? " final" : ""}`}>
      <Handle id="in" type="target" position={Position.Left} className="node-handle input-handle" />
      <div className="node-heading">
        <span className="node-kind">{data.isFinal ? "Étape finale" : "Étape"}</span>
        <button className="node-delete nodrag" type="button" onClick={() => data.onDelete(id)} aria-label="Supprimer l’étape">×</button>
      </div>
      <label>Instruction
        <textarea className="nodrag nowheel" value={data.step} onChange={(event) => data.onChange(id, "step", event.target.value)} placeholder="Ex. Mélanger et servir" rows="3" />
      </label>
      <Handle id="out" type="source" position={Position.Right} className="node-handle output-handle" />
    </article>
  );
}

const nodeTypes = { ingredient: memo(IngredientNode), action: memo(ActionNode) };

function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

function safeFilename(title, extension) {
  const stem = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recette";
  return `${stem}.${extension}`;
}

function normalizeConnection(connection) {
  if (connection.sourceHandle === "in") {
    return {
      source: connection.target,
      target: connection.source,
      sourceHandle: "out",
      targetHandle: "in",
    };
  }
  return { ...connection, sourceHandle: "out", targetHandle: "in" };
}

function GraphEditor() {
  const initial = useMemo(() => recipeToGraph(INITIAL_RECIPE, makeId), []);
  const [nodes, setNodes] = useState(initial.nodes);
  const [edges, setEdges] = useState(initial.edges);
  const [meta, setMeta] = useState(initial.meta);
  const [jsonText, setJsonText] = useState(JSON.stringify(INITIAL_RECIPE, null, 2));
  const [jsonStatus, setJsonStatus] = useState("JSON synchronisé avec le graphe.");
  const [jsonEditing, setJsonEditing] = useState(false);
  const [renderState, setRenderState] = useState({ busy: false, message: "" });
  const [previewUrl, setPreviewUrl] = useState("");
  const [widthMm, setWidthMm] = useState(280);
  const [ppi, setPpi] = useState(144);
  const [creationMenu, setCreationMenu] = useState(null);
  const fileInput = useRef(null);
  const jsonTimer = useRef(null);
  const reactFlow = useReactFlow();
  const graphResult = useMemo(() => graphToRecipe(nodes, edges, meta), [nodes, edges, meta]);
  const lastValidRecipe = useRef(INITIAL_RECIPE);

  useEffect(() => {
    if (!graphResult.ok) return;
    lastValidRecipe.current = graphResult.recipe;
    if (!jsonEditing) {
      setJsonText(JSON.stringify(graphResult.recipe, null, 2));
      setJsonStatus("JSON synchronisé avec le graphe.");
    }
  }, [graphResult, jsonEditing]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (jsonTimer.current) clearTimeout(jsonTimer.current);
  }, [previewUrl]);

  const replaceGraph = useCallback((recipe) => {
    validateRecipeDocument(recipe);
    const graph = recipeToGraph(recipe, makeId);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setMeta(graph.meta);
    lastValidRecipe.current = recipe;
    setJsonText(JSON.stringify(recipe, null, 2));
    setJsonStatus("JSON appliqué au graphe.");
    setJsonEditing(false);
    setCreationMenu(null);
    requestAnimationFrame(() => reactFlow.fitView({ padding: 0.18, duration: 350 }));
  }, [reactFlow]);

  const updateNodeData = useCallback((id, field, value) => {
    setNodes((current) => current.map((node) => node.id === id
      ? { ...node, data: { ...node.data, [field]: value } }
      : node));
  }, []);

  const deleteNode = useCallback((id) => {
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
  }, []);

  const displayNodes = useMemo(() => nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      isFinal: graphResult.ok && graphResult.rootId === node.id,
      onChange: updateNodeData,
      onDelete: deleteNode,
    },
  })), [nodes, graphResult, updateNodeData, deleteNode]);

  const displayEdges = useMemo(() => edges.map((edge) => ({
    ...edge,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  })), [edges]);

  const onNodesChange = useCallback((changes) => setNodes((current) => applyNodeChanges(changes, current)), []);
  const onEdgesChange = useCallback((changes) => setEdges((current) => applyEdgeChanges(changes, current)), []);
  const isValidConnection = useCallback((connection) => canConnect(nodes, edges, normalizeConnection(connection)), [nodes, edges]);

  const onConnect = useCallback((connection) => {
    const normalized = normalizeConnection(connection);
    if (canConnect(nodes, edges, normalized)) {
      setEdges((current) => connectOrReparent(current, normalized, makeId));
    }
  }, [nodes, edges]);

  const onReconnect = useCallback((oldEdge, connection) => {
    const withoutOld = edges.filter((edge) => edge.id !== oldEdge.id);
    const normalized = normalizeConnection(connection);
    if (!canConnect(nodes, withoutOld, normalized)) return;
    setEdges((current) => connectOrReparent(
      current.filter((edge) => edge.id !== oldEdge.id),
      normalized,
      makeId,
    ));
  }, [nodes, edges]);

  const openCreationMenu = useCallback((event, connectionState) => {
    if (connectionState.isValid || !connectionState.fromNode || connectionState.toNode) return;
    const pointer = event.changedTouches?.[0] ?? event;
    setCreationMenu({
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      flowPosition: reactFlow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY }),
      fromId: connectionState.fromNode.id,
      fromType: connectionState.fromHandle?.type ?? "source",
    });
  }, [reactFlow]);

  const createConnectedNode = useCallback((type) => {
    if (!creationMenu) return;
    const id = makeId();
    setNodes((current) => [...current, {
      id,
      type,
      position: creationMenu.flowPosition,
      data: type === "ingredient" ? { name: "Nouvel ingrédient", amount: "" } : { step: "Nouvelle étape" },
    }]);
    setEdges((current) => connectOrReparent(current, creationMenu.fromType === "target"
      ? { source: id, target: creationMenu.fromId }
      : { source: creationMenu.fromId, target: id }, makeId));
    setCreationMenu(null);
  }, [creationMenu]);

  const addLooseNode = useCallback((type) => {
    const bounds = document.querySelector(".flow-canvas")?.getBoundingClientRect();
    const position = bounds
      ? reactFlow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 0, y: 0 };
    setNodes((current) => [...current, {
      id: makeId(), type, position,
      data: type === "ingredient" ? { name: "Nouvel ingrédient", amount: "" } : { step: "Nouvelle étape" },
    }]);
  }, [reactFlow]);

  const autoLayout = useCallback(() => {
    if (!graphResult.ok) return;
    setNodes((current) => layoutGraph(current, edges, graphResult.rootId));
    requestAnimationFrame(() => reactFlow.fitView({ padding: 0.18, duration: 400 }));
  }, [edges, graphResult, reactFlow]);

  const applyJsonText = useCallback((text) => {
    try {
      const recipe = JSON.parse(text);
      validateRecipeDocument(recipe);
      replaceGraph(recipe);
    } catch (error) {
      setJsonStatus(error instanceof SyntaxError ? `JSON invalide : ${error.message}` : error.message);
    }
  }, [replaceGraph]);

  const changeJson = useCallback((event) => {
    const text = event.target.value;
    setJsonText(text);
    setJsonEditing(true);
    setJsonStatus("Modification en cours…");
    if (jsonTimer.current) clearTimeout(jsonTimer.current);
    jsonTimer.current = setTimeout(() => applyJsonText(text), 600);
  }, [applyJsonText]);

  const importJson = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { applyJsonText(await file.text()); } finally { event.target.value = ""; }
  }, [applyJsonText]);

  const renderPng = useCallback(async () => {
    const result = graphToRecipe(nodes, edges, meta);
    if (!result.ok) return;
    setRenderState({ busy: true, message: "Compilation Typst en cours…" });
    try {
      const response = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe: result.recipe, width_mm: Number(widthMm), ppi: Number(ppi) }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      setPreviewUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return url; });
      setRenderState({ busy: false, message: "PNG créé avec succès." });
    } catch (error) {
      setRenderState({ busy: false, message: error.message });
    }
  }, [nodes, edges, meta, widthMm, ppi]);

  return (
    <div className="app-shell" onClick={() => creationMenu && setCreationMenu(null)}>
      <header className="topbar">
        <div><p className="eyebrow">Éditeur Michael Chu</p><h1>Grid Recipe</h1></div>
        <div className="header-actions">
          <button type="button" className="button secondary" onClick={() => replaceGraph(INITIAL_RECIPE)}>Nouvelle recette</button>
          <button type="button" className="button secondary" onClick={() => fileInput.current?.click()}>Importer</button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importJson} />
          <button type="button" className="button secondary" onClick={() => downloadBlob(new Blob([JSON.stringify(lastValidRecipe.current, null, 2)], { type: "application/json" }), safeFilename(lastValidRecipe.current.title, "json"))}>Exporter JSON</button>
        </div>
      </header>

      <main className="workspace">
        <section className="graph-panel">
          <div className="recipe-meta">
            <label className="title-field">Titre de la recette
              <input value={meta.title} onChange={(event) => setMeta((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <div className="prep-editor">
              <div className="prep-heading"><span>Préparation préalable</span><button type="button" onClick={() => setMeta((current) => ({ ...current, pre_cooking: [...current.pre_cooking, "Nouvelle instruction"] }))}>+ Ajouter</button></div>
              {meta.pre_cooking.length === 0 ? <p className="empty-prep">Aucune instruction préalable.</p> : meta.pre_cooking.map((line, index) => (
                <div className="prep-row" key={index}>
                  <input value={line} onChange={(event) => setMeta((current) => ({ ...current, pre_cooking: current.pre_cooking.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} />
                  <button type="button" onClick={() => setMeta((current) => ({ ...current, pre_cooking: current.pre_cooking.filter((_, itemIndex) => itemIndex !== index) }))} aria-label="Supprimer l’instruction">×</button>
                </div>
              ))}
            </div>
          </div>

          <div className="graph-toolbar">
            <div><button type="button" className="tool-button ingredient-tool" onClick={() => addLooseNode("ingredient")}>+ Ingrédient</button><button type="button" className="tool-button action-tool" onClick={() => addLooseNode("action")}>+ Étape</button></div>
            <button type="button" className="tool-button" disabled={!graphResult.ok} onClick={autoLayout}>Réorganiser</button>
          </div>

          <div className="flow-wrap">
            <ReactFlow
              className="flow-canvas" nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              onReconnect={onReconnect} onConnectEnd={openCreationMenu} isValidConnection={isValidConnection}
              connectionMode={ConnectionMode.Loose} deleteKeyCode={["Backspace", "Delete"]}
              fitView fitViewOptions={{ padding: 0.18 }} minZoom={0.25} maxZoom={1.8}
              defaultEdgeOptions={{ type: "smoothstep" }} proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="#b9c2bb" />
              <MiniMap pannable zoomable nodeColor={(node) => node.type === "ingredient" ? "#dfeee2" : "#f5eee3"} />
              <Controls showInteractive={false} />
            </ReactFlow>
            <div className={`graph-validity ${graphResult.ok ? "valid" : "invalid"}`} role="status">{graphResult.ok ? "Graphe valide" : graphResult.error}</div>
          </div>
        </section>

        <aside className="side-panel">
          <section className="side-card json-card">
            <div className="card-heading"><div><p className="eyebrow">Source</p><h2>JSON synchronisé</h2></div><button type="button" onClick={() => navigator.clipboard.writeText(jsonText)}>Copier</button></div>
            {!graphResult.ok && <p className="draft-note">Le JSON conserve la dernière recette valide pendant que le graphe est incomplet.</p>}
            <textarea spellCheck="false" value={jsonText} onFocus={() => setJsonEditing(true)} onBlur={() => { setJsonEditing(false); applyJsonText(jsonText); }} onChange={changeJson} aria-label="JSON de la recette" />
            <p className="status-line">{jsonStatus}</p>
          </section>

          <section className="side-card render-card">
            <div className="card-heading"><div><p className="eyebrow">Typst</p><h2>Créer l’image</h2></div></div>
            <details><summary>Options avancées</summary><div className="render-options">
              <label>Largeur (mm)<input type="number" min="80" max="500" value={widthMm} onChange={(event) => setWidthMm(event.target.value)} /></label>
              <label>Résolution (PPI)<input type="number" min="72" max="300" value={ppi} onChange={(event) => setPpi(event.target.value)} /></label>
            </div></details>
            <button type="button" className="button primary render-button" disabled={!graphResult.ok || renderState.busy} onClick={renderPng}>{renderState.busy ? "Compilation…" : "Créer le PNG"}</button>
            <p className="status-line">{renderState.message || (!graphResult.ok ? "Reliez tous les nœuds pour activer le rendu." : "Prêt à compiler.")}</p>
          </section>

          {previewUrl && <section className="side-card preview-card"><div className="card-heading"><h2>Aperçu</h2><a href={previewUrl} download={safeFilename(lastValidRecipe.current.title, "png")}>Télécharger</a></div><img src={previewUrl} alt="Recette compilée en PNG" /></section>}
        </aside>
      </main>

      {creationMenu && <div className="creation-menu" style={{ left: creationMenu.clientX, top: creationMenu.clientY }} onClick={(event) => event.stopPropagation()}>
        <p>Créer et relier</p>
        {creationMenu.fromType === "target" && <button type="button" onClick={() => createConnectedNode("ingredient")}>Ingrédient</button>}
        <button type="button" onClick={() => createConnectedNode("action")}>Étape</button>
      </div>}
    </div>
  );
}

export default function App() {
  return <ReactFlowProvider><GraphEditor /></ReactFlowProvider>;
}
