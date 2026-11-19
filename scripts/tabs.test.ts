import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";

// Exercise the shipped tab bar's wheel handler and tab groups without a window or a core.
type Handler = (event: unknown) => void;
class Element {
  nodes: Element[] = [];
  calls: Record<string, unknown[]> = {};
  constructor() {
    const proxy: Element = new Proxy(this, {
      get: (target, key: string) => key in target ? Reflect.get(target, key) : (...args: unknown[]) => {
        if (key === "child") target.nodes.push(args[0] as Element);
        else if (key === "children") target.nodes.push(...(args[0] as Element[]));
        else if (key === "when") { if (args[0]) (args[1] as (el: Element) => void)(proxy); }
        else target.calls[key] = args;
        return proxy;
      },
    });
    return proxy;
  }
}
const source = await readFile(new URL("../defaults/mods/tabs/main.js", import.meta.url), "utf8");
const element = () => new Element();
const commands: string[] = [];
const runs: [string, unknown][] = [];
const store: Record<string, string> = {};
const threeTabs = () => [{ id: "t1", name: "a" }, { id: "t2", name: "b", active: true }, { id: "t3", name: "c" }];
let tabs: Record<string, unknown>[] = threeTabs();
// What the mod keeps in shared "tab-groups".
let groups: any = null;
const values: Record<string, unknown> = {
  View: class {}, div: element, svg: element, image: element, h_flex: element,
  ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, InputState: { new: () => ({}) }, Input: { new: element },
  spaces: () => [{ id: "s1", active: true, tabs }],
  panes: () => [], run(command: string, args?: unknown) { commands.push(command); runs.push([command, args]); }, openOverlay() {}, theme: () => ({}),
  window: () => null, shared: (key: string) => (key === "tab-groups" ? groups : null), setShared(_key: string, value: unknown) { groups = value; },
  layout: () => null, settings: () => ({ zoom: 1 }),
  localStorage: { getItem: (key: string) => store[key] ?? null, setItem(key: string, value: string) { store[key] = value; } },
};
const Tabs = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "").replace("export default class Tabs", "return class Tabs"))(...Object.values(values));

let now = 1_000_000;
function wheel() {
  const view = new Tabs();
  view.init();
  // The mod is plain JS: its handler's shape is the documented ScrollWheelEvent listener.
  const handler = (view.render() as Element).calls.on_scroll_wheel[0] as Handler;
  return (y: number, touch_phase = "moved", lines?: number, ms = 8) => {
    now += ms;
    setSystemTime(new Date(now));
    handler({ delta: { x: 0, y }, delta_lines: lines === undefined ? undefined : { x: 0, y: lines }, touch_phase });
  };
}
beforeEach(() => { commands.length = 0; runs.length = 0; tabs = threeTabs(); groups = null; });
// Bun runs every test file in one process: give the later ones the real clock.
afterAll(() => setSystemTime());

test("a short touchpad swipe switches one tab", () => {
  const send = wheel();
  for (let i = 0; i < 12; i++) send(-6);
  expect(commands).toEqual(["tab.next"]);
});

test("a nudge below the threshold switches nothing", () => {
  const send = wheel();
  for (let i = 0; i < 3; i++) send(-5);
  expect(commands).toEqual([]);
});

test("each notch of a smooth-scrolling mouse switches one tab", () => {
  const send = wheel();
  // macOS smooths one notch into about 28 events of 1 px.
  for (let i = 0; i < 28; i++) send(-1, "moved", undefined, 10);
  send(-1, "moved", undefined, 700);
  for (let i = 0; i < 27; i++) send(-1, "moved", undefined, 10);
  expect(commands).toEqual(["tab.next", "tab.next"]);
});

test("a long swipe keeps switching, a tab per 60 px", () => {
  const send = wheel();
  // 20 px for the first tab, then 60 px each: 400 px is seven tabs.
  for (let i = 0; i < 40; i++) send(10, "moved", undefined, 40);
  expect(commands).toEqual(Array(7).fill("tab.prev"));
});

test("a fast flick shows each tab it passes for at least 100 ms", () => {
  const send = wheel();
  // 1200 px within 240 ms: enough for twenty tabs, time for three.
  for (let i = 0; i < 30; i++) send(-40);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.next"]);
});

test("a pause or a turn starts a new gesture", () => {
  const send = wheel();
  for (let i = 0; i < 12; i++) send(-6);
  send(-30, "moved", undefined, 400);
  for (let i = 0; i < 4; i++) send(-5);
  for (let i = 0; i < 12; i++) send(6, "moved", undefined, 20);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.prev"]);
});

test("each wheel notch switches one tab", () => {
  const send = wheel();
  send(-20, "moved", -1);
  send(-20, "moved", -1);
  send(2, "moved", 0.1);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.prev"]);
});

// The ids of the tab and group chips the bar draws, in order.
function shownIds(root: any): string[] {
  if (!root || typeof root !== "object") return [];
  const id = root.calls?.id?.[0];
  return [...(/^(tab-t\d+|group-g\d+)$/.test(id) ? [id] : []), ...(root.nodes ?? []).flatMap(shownIds)];
}
const group = (collapsed = false, kept?: string) => ({ name: "api", color: "ansi4", collapsed, ...(kept ? { kept } : {}) });

test("a group's chip comes before its tabs, and a folded group shows only the tab it kept", () => {
  groups = { groups: { g1: group() }, of: { t2: "g1", t3: "g1" } };
  const view = new Tabs();
  view.init();
  expect(shownIds(view.render())).toEqual(["tab-t1", "group-g1", "tab-t2", "tab-t3"]);
  groups = { groups: { g1: group(true, "t2") }, of: { t2: "g1", t3: "g1" } };
  tabs[2].settled = true;
  expect(shownIds(view.render())).toEqual(["tab-t1", "group-g1", "tab-t2"]);
  expect(runs).toEqual([]);
});

test("folding never switches tabs: the shown tab stays and the rest settle", () => {
  groups = { groups: { g1: group() }, of: { t1: "g1", t2: "g1" } };
  const view = new Tabs();
  view.init();
  view.toggle("g1", "s1");
  expect(runs).toEqual([["tab.settle", { id: "t1" }]]);
  expect(groups.groups.g1).toMatchObject({ collapsed: true, kept: "t2" });
});

test("a folded group's kept tab folds once another tab is shown", () => {
  tabs = [{ id: "t1", settled: true }, { id: "t2", name: "b" }, { id: "t3", name: "c", active: true }];
  groups = { groups: { g1: group(true, "t2") }, of: { t1: "g1", t2: "g1" } };
  const view = new Tabs();
  view.init();
  view.render();
  expect(runs).toEqual([["tab.settle", { id: "t2" }]]);
  expect(groups.groups.g1.kept).toBeNull();
});

test("a tab removed from its group moves after the group's other tabs", () => {
  tabs = [...threeTabs(), { id: "t4", name: "d" }];
  groups = { groups: { g1: group() }, of: { t1: "g1", t2: "g1", t3: "g1" } };
  const view = new Tabs();
  view.init();
  view.ungroup("t1", { id: "s1", tabs });
  expect(runs).toEqual([["tab.move", { id: "t1", index: 3 }]]);
  expect(groups.of).toEqual({ t2: "g1", t3: "g1" });
});

const label = new Function("View", `${source.replace(/^import .*;\n/gm, "").replace("export default class Tabs", "class Tabs")}; return label;`)(class {});

const claude = { program: { name: "Claude Code", key: "claude", agent: true }, title: "my-task" };

test("a tab Herdr named after its agent follows the agent's session title", () => {
  expect(label({ name: "Claude Code", named: true }, claude)).toBe("my-task");
  expect(label({ name: "", named: false }, claude)).toBe("my-task");
  expect(label({ name: "", named: false }, { ...claude, title: "✦ [web] login" })).toBe("[web] login");
  expect(label({ name: "Claude Code", named: true }, { ...claude, title: "renamed-task" })).toBe("renamed-task");
});

test("an empty OSC title published as the terminal address keeps the program label", () => {
  for (const terminal of ["t2", "remote/t2"]) {
    const lead = { ...claude, terminal, title: terminal };
    expect(label({ name: "2", named: false }, lead)).toBe("Claude Code");
    expect(label({ name: "Claude Code", named: true }, lead)).toBe("Claude Code");
    expect(label({ name: "fix login", named: true }, lead)).toBe("fix login");
    expect(label({ name: "2", named: false }, { ...lead, title: "renamed-task" })).toBe("renamed-task");
  }
});

test("a name the person gave stays", () => {
  expect(label({ name: "fix login", named: true }, claude)).toBe("fix login");
});

test("a title that says nothing new keeps the tab's own name", () => {
  expect(label({ name: "Claude Code", named: true }, { ...claude, title: "Claude Code" })).toBe("Claude Code");
  expect(label({ name: "Claude Code", named: true }, { ...claude, title: "me@build-box" })).toBe("Claude Code");
  expect(label({ name: "", named: false }, { ...claude, title: "" })).toBe("Claude Code");
  expect(label({ name: "", named: false }, { ...claude, title: "~/src/api" })).toBe("Claude Code");
  expect(label({ name: "", named: false }, { ...claude, title: "✦ /tmp" })).toBe("Claude Code");
});

test("a shell's title never replaces its tab's name", () => {
  const shell = { program: { name: "zsh", key: "zsh" }, title: "vim notes.md" };
  expect(label({ name: "", named: false }, shell)).toBe("zsh");
  expect(label({ name: "notes", named: true }, shell)).toBe("notes");
  expect(label({ name: "", named: false }, undefined)).toBe("Terminal");
});
