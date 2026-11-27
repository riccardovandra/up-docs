// Design rooms for tests: the real DesignBridge and tickets, with a scripted
// editor standing in for the OpenPencil fork's automation bridge.

import {
  DesignBridge,
  issueDesignTicket,
  spendDesignTicket,
  type BridgeSocket,
  type TicketStorage,
} from "../designBridge.ts";
import {
  allowedDesignTools,
  parseDesignTools,
  type DesignAgentPort,
  type DesignRoomPort,
} from "../designAgent.ts";

const schema = (properties: Record<string, unknown> = {}, required: Array<string> = []) => ({
  type: "object",
  properties,
  required,
});

/** A few tools in the release's up-docs-tools.json shape. */
export const TOOL_LIST_FIXTURE = {
  counts: { allowed: 9 },
  tools: [
    {
      name: "list_pages",
      description: "List all pages in the document.",
      mutates: false,
      capabilities: ["document:read"],
      evaluatesCode: false,
      inputSchema: schema(),
    },
    {
      name: "get_page_tree",
      description: "Get the node tree of the current page. Returns lightweight hierarchy.",
      mutates: false,
      capabilities: ["document:read"],
      evaluatesCode: false,
      inputSchema: schema({ depth: { type: "number" } }),
    },
    {
      name: "get_jsx",
      description: "The JSX of nodes.",
      mutates: false,
      capabilities: ["document:read"],
      evaluatesCode: false,
      inputSchema: schema({
        path: { type: "string", description: "Write it to this path (requires OPENPENCIL_MCP_ROOT)" },
      }),
    },
    {
      name: "create_shape",
      description: "Create a shape on the canvas. Use FRAME for containers.",
      mutates: true,
      capabilities: ["document:write"],
      evaluatesCode: false,
      inputSchema: schema({ type: { type: "string" }, x: {}, y: {} }, ["type", "x", "y"]),
    },
    {
      name: "set_fill",
      description: "Set fill on a node.",
      mutates: true,
      capabilities: ["document:write"],
      evaluatesCode: false,
      inputSchema: schema({ id: { type: "string" }, color: { type: "string" } }, ["id"]),
    },
    {
      name: "export_svg",
      description: "Export nodes as SVG markup.",
      mutates: false,
      capabilities: ["document:read"],
      evaluatesCode: false,
      inputSchema: schema({
        ids: { type: "array" },
        path: { type: "string", description: "Write exported data here (requires OPENPENCIL_MCP_ROOT)" },
      }),
    },
    {
      name: "zoom_to_fit",
      description: "Zoom the viewport to fit.",
      mutates: true,
      capabilities: ["document:read"],
      evaluatesCode: false,
      inputSchema: schema(),
    },
    {
      name: "set_variable",
      description: "Set a variable's value.",
      mutates: true,
      capabilities: ["document:write"],
      evaluatesCode: false,
      inputSchema: schema(),
    },
    {
      name: "render",
      description: "Render JSX into the design.",
      mutates: true,
      capabilities: ["document:write"],
      evaluatesCode: true,
      inputSchema: schema({ jsx: { type: "string" } }, ["jsx"]),
    },
  ],
};

interface FakeNode {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  fill?: string;
}

/** What one fake editor holds: its layers and its undo history ("Agent: ..." or the user's). */
export interface FakeEditor {
  readonly nodes: Array<FakeNode>;
  readonly history: Array<{ label: string; undo: () => void }>;
  readonly received: Array<{ command: string; args: Record<string, unknown> }>;
  /** Commands it never answers (the bridge's timeout ends them). */
  readonly hang: Set<string>;
  readonly socket: BridgeSocket;
  open: boolean;
}

type Reply = { ok: true; result: unknown } | { ok: false; error: string };

function run(editor: FakeEditor, command: string, args: Record<string, unknown>): Reply {
  if (command === "selection") return { ok: true, result: [] };
  if (command === "export") return { ok: true, result: { base64: "iVBORw0KGgo=", mimeType: "image/png" } };
  if (command === "undo") {
    const top = editor.history.at(-1);
    if (!top) return { ok: true, result: { applied: false, label: null } };
    if (!top.label.startsWith("Agent: ")) {
      return { ok: false, error: `The last change ("${top.label}") was made in the editor` };
    }
    editor.history.pop();
    top.undo();
    return { ok: true, result: { applied: true, label: top.label } };
  }
  if (command !== "tool") return { ok: false, error: `unknown command ${command}` };
  const name = args.name as string;
  const toolArgs = (args.args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "list_pages":
      return { ok: true, result: [{ id: "0:1", name: "Page 1" }] };
    case "get_page_tree":
      return { ok: true, result: { nodes: editor.nodes.map(({ id, type, name }) => ({ id, type, name })) } };
    case "get_jsx":
      return { ok: true, result: { jsx: "<Frame/>".repeat(5_000) } };
    case "export_svg":
      return { ok: true, result: { svg: "<svg/>", args: toolArgs } };
    case "create_shape": {
      const node = { id: `1:${editor.nodes.length + 1}`, type: String(toolArgs.type), name: String(toolArgs.name ?? toolArgs.type) };
      editor.nodes.push(node);
      editor.history.push({
        label: "Agent: create_shape",
        undo: () => editor.nodes.splice(editor.nodes.indexOf(node), 1),
      });
      return { ok: true, result: { id: node.id } };
    }
    case "set_fill": {
      const node = editor.nodes.find((candidate) => candidate.id === toolArgs.id);
      // Like OpenPencil's atomic tools: the failure is in the result.
      if (!node) return { ok: true, result: { error: `Node "${String(toolArgs.id)}" not found` } };
      const before = node.fill;
      node.fill = String(toolArgs.color);
      editor.history.push({
        label: "Agent: set_fill",
        undo: () => {
          if (before === undefined) delete node.fill;
          else node.fill = before;
        },
      });
      return { ok: true, result: { id: node.id, fill: node.fill } };
    }
    default:
      return { ok: true, result: { ran: name } };
  }
}

function memoryStorage(): TicketStorage {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => void map.set(key, value),
    delete: async (keys) => {
      let count = 0;
      for (const key of Array.isArray(keys) ? keys : [keys]) if (map.delete(key)) count += 1;
      return count;
    },
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...map].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
  };
}

/** Rooms by design id, each with a bridge, tickets and the editors that opened it. */
export function makeDesignRooms(input: { readonly isolatedEditor?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const timers = new Set<() => void>();
  const rooms = new Map<
    string,
    DesignRoomPort & { readonly editors: Array<FakeEditor>; readonly bridge: DesignBridge }
  >();
  /** Requests each room's socket handshake received. */
  const handshakes: Array<Request> = [];

  const room = (designId: string) => {
    const existing = rooms.get(designId);
    if (existing) return existing;
    const storage = memoryStorage();
    const editors: Array<FakeEditor> = [];
    const newest = () => editors.filter((editor) => editor.open).at(-1) ?? null;
    const bridge: DesignBridge = new DesignBridge({
      editor: () => newest()?.socket ?? null,
      setTimer: (fire) => {
        timers.add(fire);
        return fire;
      },
      clearTimer: (timer) => timers.delete(timer as () => void),
      newId: () => crypto.randomUUID(),
    });
    const made = {
      editors,
      bridge,
      issueTicket: () => issueDesignTicket(storage, clock.now),
      status: async () => ({ connected: newest() !== null }),
      command: (command: string, args: unknown) => bridge.command(command, args),
      fetch: async (request: Request) => {
        handshakes.push(request);
        const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
        if (!(await spendDesignTicket(storage, ticket, clock.now))) {
          return new Response("Ticket refused", { status: 403 });
        }
        for (const editor of editors) editor.open = false;
        editors.push(openEditor());
        // Node's Response cannot carry 101; the route only passes it through.
        return new Response("socket open", { status: 200 });
      },
    };
    const openEditor = (): FakeEditor => {
      const editor: FakeEditor = {
        nodes: [],
        history: [],
        received: [],
        hang: new Set(),
        open: true,
        socket: {
          send: (data) => {
            const message = JSON.parse(data) as {
              type: string;
              id: string;
              command: string;
              args: Record<string, unknown>;
            };
            if (message.type !== "request") return;
            editor.received.push({ command: message.command, args: message.args });
            const key = message.command === "tool" ? String(message.args.name) : message.command;
            if (editor.hang.has(key)) return;
            const reply = run(editor, message.command, message.args);
            queueMicrotask(() =>
              bridge.receive(editor.socket, JSON.stringify({ type: "response", id: message.id, ...reply })),
            );
          },
        },
      };
      return editor;
    };
    rooms.set(designId, made);
    return made;
  };

  /** Opens an editor on a design, as the design page and editor do: a ticket, then the socket. */
  const open = async (designId: string) => {
    const { ticket } = await room(designId).issueTicket();
    const url = new URL(`https://docs.test/api/designs/${designId}/agent`);
    url.searchParams.set("ticket", ticket);
    await room(designId).fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
    return room(designId).editors.at(-1)!;
  };

  const close = (designId: string) => {
    for (const editor of room(designId).editors) {
      editor.open = false;
      room(designId).bridge.dropped(editor.socket);
    }
  };

  /** Fires every pending command timeout, as 20 s passing would. */
  const timeOut = () => {
    for (const fire of [...timers]) {
      timers.delete(fire);
      fire();
    }
  };

  const isolatedEditor = input.isolatedEditor ?? true;
  const port: DesignAgentPort = {
    room,
    isolatedEditor,
    tools: async () => allowedDesignTools(parseDesignTools(TOOL_LIST_FIXTURE), isolatedEditor),
  };
  return { port, room, open, close, timeOut, clock, handshakes };
}
