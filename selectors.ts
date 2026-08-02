import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  type ExtensionContext,
  getSelectListTheme,
  ThinkingSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type KeybindingsManager,
  type SelectItem,
  SelectList,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { REASONING_LEVELS } from "./config";

/**
 * Interactive pickers for the classifier model and reasoning level.
 *
 * These mirror pi's own `/model` and thinking-level selectors — same fuzzy search, same
 * keys, same list theme — but they are deliberately *not* the built-in components.
 * `ModelSelectorComponent` calls `settingsManager.setDefaultModelAndProvider()` when you
 * pick, which would repoint the whole session at the classifier model. The thinking
 * selector is reused directly, since it has no such side effect.
 */

const MAX_VISIBLE = 12;

/** Keys the list owns; everything else is treated as typing into the search box. */
const NAVIGATION_KEYS = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.confirm",
  "tui.select.cancel",
] as const;

/** Shown when the picker cannot be used because there is no terminal to draw it in. */
export function canPrompt(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

/**
 * Pick a classifier model from those whose providers have resolved auth. Resolves
 * `provider/model-id`, or undefined when cancelled.
 */
export async function selectModel(ctx: ExtensionContext, current: string | undefined): Promise<string | undefined> {
  const available = readAvailable(ctx);
  if (available.length === 0) return undefined;

  const items = toItems(available, current);

  return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
    return new ModelPicker(tui, keybindings, items, (value) => done(value), () => done(undefined));
  });
}

/** Pick a reasoning level. Resolves the level, or undefined when cancelled. */
export async function selectReasoning(
  ctx: ExtensionContext,
  current: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
  return ctx.ui.custom<ThinkingLevel | undefined>((_tui, _theme, _keybindings, done) => {
    return new ReasoningPicker(current, (level) => done(level), () => done(undefined));
  });
}

/** Models pi currently considers usable, as `provider/model-id`. */
export function readAvailable(ctx: ExtensionContext): Model<Api>[] {
  try {
    return [...ctx.modelRegistry.getAvailable()];
  } catch {
    // A captured context goes stale across session replacement or /reload.
    return [];
  }
}

export function modelName(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/** Current model first, then grouped by provider — the ordering pi's selector uses. */
function toItems(models: Model<Api>[], current: string | undefined): SelectItem[] {
  const sorted = [...models].sort((a, b) => {
    const aCurrent = modelName(a) === current;
    const bCurrent = modelName(b) === current;
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    return modelName(a).localeCompare(modelName(b));
  });

  return sorted.map((model) => ({
    value: modelName(model),
    label: modelName(model),
    description: modelName(model) === current ? `${model.name} (current)` : model.name,
  }));
}

/**
 * A search box above a filtered list, with the same key routing as pi's model selector:
 * navigation and confirm/cancel go to the list, every other keystroke edits the query.
 */
class ModelPicker extends Container {
  private readonly search = new Input();
  private readonly listContainer = new Container();
  private list: SelectList;
  private query = "";

  constructor(
    private readonly tui: TUI,
    private readonly keybindings: KeybindingsManager,
    private readonly items: SelectItem[],
    private readonly onSelect: (value: string) => void,
    private readonly onCancel: () => void,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text("Select cruise-control classifier model", 1, 0));
    this.addChild(this.search);
    this.addChild(this.listContainer);
    this.addChild(new DynamicBorder());

    this.list = this.buildList(items);
    this.listContainer.addChild(this.list);
    this.search.focused = true;
  }

  handleInput(keyData: string): void {
    if (NAVIGATION_KEYS.some((binding) => this.keybindings.matches(keyData, binding))) {
      this.list.handleInput(keyData);
      this.tui.requestRender();
      return;
    }

    this.search.handleInput(keyData);
    const next = this.search.getValue();
    if (next === this.query) return;

    this.query = next;
    this.applyFilter();
    this.tui.requestRender();
  }

  /**
   * SelectList only filters by prefix, so filtering is done here with the same
   * `fuzzyFilter` pi uses and the list is rebuilt from the result. Rebuilding also
   * moves the highlight to the best match, which is what pi does on every keystroke.
   */
  private applyFilter(): void {
    const filtered = this.query
      ? fuzzyFilter(this.items, this.query, (item) => `${item.value} ${item.description ?? ""}`)
      : this.items;

    this.listContainer.clear();
    this.list = this.buildList(filtered);
    this.listContainer.addChild(this.list);
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme(), {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 48,
    });
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = () => this.onCancel();
    return list;
  }
}

/**
 * pi's own thinking-level selector. It renders and preselects but exposes no
 * `handleInput`, so this wrapper forwards keys to the list inside it.
 */
class ReasoningPicker extends Container {
  private readonly selector: ThinkingSelectorComponent;

  constructor(current: ThinkingLevel, onSelect: (level: ThinkingLevel) => void, onCancel: () => void) {
    super();
    this.selector = new ThinkingSelectorComponent(
      current,
      [...REASONING_LEVELS],
      (level) => onSelect(level as ThinkingLevel),
      onCancel,
    );
    this.addChild(this.selector);
  }

  handleInput(keyData: string): void {
    this.selector.getSelectList().handleInput(keyData);
  }
}
