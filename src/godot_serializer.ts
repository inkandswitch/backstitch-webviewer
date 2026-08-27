export interface OrderedProperty {
  value: string;
  order: number;
}

export interface TypeOrInstance {
  Type?: string;
  Instance?: string;
}

export interface NodeId {
  id: number;
  root_instance_id: number[] | null;
}

export interface GodotNode {
  id: NodeId;
  name: string;
  type_or_instance?: TypeOrInstance;
  instance_placeholder?: string;
  parent_id?: NodeId;
  parent_path_fallback?: string;
  parent_id_path?: number[];
  owner?: string;
  owner_uid_path?: number[];
  index?: number;
  groups?: string;
  node_paths?: string;
  properties: Record<string, OrderedProperty>;
  child_node_ids: NodeId[];
}

export interface ExternalResourceNode {
  resource_type: string;
  uid?: string;
  path: string;
  id: string;
  idx: number;
}

export interface SubResourceNode {
  id: string;
  resource_type: string;
  properties: Record<string, OrderedProperty>;
  idx: number;
}

export interface GodotConnection {
  signal: string;
  from_node_id: NodeId;
  to_node_id: NodeId;
  method: string;
  flags?: number;
  from_uid_path?: number[];
  to_uid_path?: number[];
  unbinds?: number;
  binds?: string;
}

export interface GodotScene {
  load_steps: number;
  format: number;
  uid: string;
  script_class?: string;
  resource_type: string;
  root_node_id?: NodeId;
  ext_resources: Record<string, ExternalResourceNode>;
  sub_resources: Record<string, SubResourceNode>;
  nodes: Record<string, GodotNode>;
  connections: Record<string, GodotConnection>;
  editable_instances: string[];
  main_resource?: SubResourceNode;
}

function nodeIdToString(nodeId: NodeId): string {
  let key = String(nodeId.id);
  if (nodeId.root_instance_id && nodeId.root_instance_id.length > 0) {
    for (const id of nodeId.root_instance_id) {
      key += `-${id}`;
    }
  }
  return key;
}

function nodeIdsEqual(a: NodeId, b: NodeId): boolean {
  return nodeIdToString(a) === nodeIdToString(b);
}

function serializePackedInt32Array(arr: number[]): string {
  return `PackedInt32Array(${arr.join(", ")})`;
}

export function serializeGodotScene(structured_content: GodotScene): string {
  let output = "";

  // Write header
  if (structured_content.resource_type !== "PackedScene") {
    output += `[gd_resource type="${structured_content.resource_type}"`;
    if (structured_content.script_class) {
      output += ` script_class="${structured_content.script_class}"`;
    }
  } else {
    output += "[gd_scene";
  }

  if (structured_content.load_steps !== 0) {
    output += ` load_steps=${structured_content.load_steps}`;
  }
  output += ` format=${structured_content.format} uid="${structured_content.uid}"]\n\n`;

  // Write external resources
  const sortedExtResources = Object.entries(structured_content.ext_resources).sort(
    ([, a], [, b]) => a.idx - b.idx,
  );

  for (const [, resource] of sortedExtResources) {
    output += `[ext_resource type="${resource.resource_type}"`;
    if (resource.uid) {
      output += ` uid="${resource.uid}"`;
    }
    output += ` path="${resource.path}" id="${resource.id}"]\n`;
  }

  if (sortedExtResources.length > 0) {
    output += "\n";
  }

  // Write sub-resources
  const sortedSubResources = Object.entries(structured_content.sub_resources).sort(
    ([, a], [, b]) => a.idx - b.idx,
  );

  for (const [, resource] of sortedSubResources) {
    output += `[sub_resource type="${resource.resource_type}" id="${resource.id}"]\n`;

    const sortedProps = Object.entries(resource.properties).sort(
      ([, a], [, b]) => a.order - b.order,
    );

    for (const [key, property] of sortedProps) {
      output += `${key} = ${property.value}\n`;
    }
    output += "\n";
  }

  // Write main resource if it exists
  if (structured_content.main_resource) {
    output += "[resource]\n";
    const sortedProps = Object.entries(structured_content.main_resource.properties).sort(
      ([, a], [, b]) => a.order - b.order,
    );

    for (const [key, property] of sortedProps) {
      output += `${key} = ${property.value}\n`;
    }
    return output;
  } else if (structured_content.resource_type !== "PackedScene") {
    console.error("resource with no resource tag!!");
  }

  // Write nodes
  const nodePathMap = new Map<string, number>();

  if (structured_content.nodes && structured_content.root_node_id) {
    const rootKey = nodeIdToString(structured_content.root_node_id);
    const rootNode = structured_content.nodes[rootKey];
    if (rootNode) {
      output += serializeNode(rootNode, structured_content, nodePathMap);
      // Mirror Rust: pop trailing newline when no connections and no editable instances
      if (
        structured_content.connections &&
        Object.keys(structured_content.connections).length === 0 &&
        structured_content.editable_instances.length === 0 &&
        output.endsWith("\n\n")
      ) {
        output = output.slice(0, -1);
      }
    }
  }

  // Write connections
  const sortedConnections = Object.entries(structured_content.connections).sort(([, a], [, b]) => {
    const aKey = nodeIdToString(a.from_node_id);
    const bKey = nodeIdToString(b.from_node_id);
    const aSort = nodePathMap.get(aKey) ?? -1;
    const bSort = nodePathMap.get(bKey) ?? -1;
    if (aSort === bSort) {
      return a.signal.localeCompare(b.signal);
    }
    return aSort - bSort;
  });

  for (const [, connection] of sortedConnections) {
    const fromPath = getNodePath(connection.from_node_id, structured_content);
    const toPath = getNodePath(connection.to_node_id, structured_content);

    output += `[connection signal="${connection.signal}" from="${fromPath}" to="${toPath}" method="${connection.method}"`;
    if (connection.flags !== undefined && connection.flags !== null) {
      output += ` flags=${connection.flags}`;
    }
    if (connection.from_uid_path && connection.from_uid_path.length > 0) {
      output += ` from_uid_path=${serializePackedInt32Array(connection.from_uid_path)}`;
    }
    if (connection.to_uid_path && connection.to_uid_path.length > 0) {
      output += ` to_uid_path=${serializePackedInt32Array(connection.to_uid_path)}`;
    }
    if (connection.unbinds !== undefined && connection.unbinds !== null) {
      output += ` unbinds=${connection.unbinds}`;
    }
    if (connection.binds) {
      output += ` binds=${connection.binds}`;
    }
    output += "]\n";
  }

  // Blank line between connections and editable instances
  if (sortedConnections.length > 0 && structured_content.editable_instances.length > 0) {
    output += "\n";
  }

  // Write editable instances
  for (const path of structured_content.editable_instances) {
    output += `[editable path="${path}"]\n`;
  }

  return output;
}

export function serializeGodotSceneAsUint8Array(structured_content: GodotScene): Uint8Array {
  return new TextEncoder().encode(serializeGodotScene(structured_content));
}

function serializeNode(
  node: GodotNode,
  scene: GodotScene,
  nodePathMap: Map<string, number>,
): string {
  let output = "";
  output += `[node name="${node.name}"`;

  const type = node.type_or_instance?.Type;
  const instance = node.type_or_instance?.Instance;

  if (type) {
    output += ` type="${type}"`;
  }

  if (node.parent_id) {
    let parentName: string;
    if (scene.root_node_id && nodeIdsEqual(node.parent_id, scene.root_node_id)) {
      parentName = ".";
    } else if (node.parent_path_fallback) {
      parentName = node.parent_path_fallback;
    } else {
      parentName = getNodePath(node.parent_id, scene);
    }
    output += ` parent="${parentName}"`;

    if (node.parent_id_path && node.parent_id_path.length > 0) {
      output += ` parent_id_path=${serializePackedInt32Array(node.parent_id_path)}`;
    }
  }

  if (node.owner) {
    output += ` owner="${node.owner}"`;
    if (node.owner_uid_path && node.owner_uid_path.length > 0) {
      output += ` owner_uid_path=${serializePackedInt32Array(node.owner_uid_path)}`;
    }
  }

  if (node.index !== undefined && node.index !== null) {
    output += ` index="${node.index}"`;
  }

  // unique_id uses only the plain integer part (node.id.id), matching Rust behavior
  output += ` unique_id=${node.id.id}`;

  if (node.node_paths) {
    output += ` node_paths=${node.node_paths}`;
  }

  if (node.groups) {
    output += ` groups=${node.groups}`;
  }

  if (node.instance_placeholder) {
    output += ` instance_placeholder=${node.instance_placeholder}`;
  }

  if (instance) {
    output += ` instance=${instance}`;
  }

  output += "]\n";

  nodePathMap.set(nodeIdToString(node.id), nodePathMap.size);

  // Write properties
  const sortedProps = Object.entries(node.properties).sort(([, a], [, b]) => a.order - b.order);

  for (const [key, property] of sortedProps) {
    output += `${key} = ${property.value}\n`;
  }

  // Always add a blank line after a node's properties block (mirrors Rust behavior)
  output += "\n";

  // Recursively serialize children
  for (const childId of node.child_node_ids) {
    const childKey = nodeIdToString(childId);
    const childNode = scene.nodes[childKey];
    if (childNode) {
      output += serializeNode(childNode, scene, nodePathMap);
    }
  }

  return output;
}

function getNodePath(nodeId: NodeId, scene: GodotScene): string {
  const key = nodeIdToString(nodeId);
  const node = scene.nodes[key];
  if (!node) return "";

  if (scene.root_node_id && nodeIdsEqual(nodeId, scene.root_node_id)) {
    return ".";
  }

  let path = node.name;
  let currentId = nodeId;

  while (true) {
    const currentKey = nodeIdToString(currentId);
    const currentNode = scene.nodes[currentKey];
    if (!currentNode) break;

    // Use parent_path_fallback if set (for instanced scene nodes without a resolvable parent_id)
    if (currentNode.parent_path_fallback) {
      const fallback = currentNode.parent_path_fallback;
      if (fallback === ".") {
        return path;
      }
      return `${fallback}/${path}`;
    }

    if (!currentNode.parent_id) break;

    const parentId = currentNode.parent_id;
    if (scene.root_node_id && nodeIdsEqual(parentId, scene.root_node_id)) {
      return path;
    }

    const parentKey = nodeIdToString(parentId);
    const parentNode = scene.nodes[parentKey];
    if (!parentNode) break;

    path = `${parentNode.name}/${path}`;
    currentId = parentId;
  }

  return path;
}
