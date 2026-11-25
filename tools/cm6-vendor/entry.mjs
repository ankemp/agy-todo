export {
  EditorState,
  StateField,
  StateEffect,
  Compartment,
  RangeSetBuilder,
  Prec,
  Transaction,
} from '@codemirror/state';

export {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
  drawSelection,
} from '@codemirror/view';

export {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
} from '@codemirror/commands';

export {
  syntaxTree,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';

export {
  markdown,
} from '@codemirror/lang-markdown';

export {
  Strikethrough,
  TaskList,
  Autolink,
} from '@lezer/markdown';

export {
  tags,
} from '@lezer/highlight';
