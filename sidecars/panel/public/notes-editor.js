/**
 * Hybrid live-preview Markdown notes editor for AGY Todo auxiliary pane.
 * Exposed as window.AGYNotesEditor in classic script tags and CommonJS module.exports in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    var api = factory(root);
    root.AGYNotesEditor = api;
    if (root && root.window && root.window !== root) {
      root.window.AGYNotesEditor = api;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var cachedCommonJsCm = null;

  var INLINE_CONTAINER_TYPES = {
    StrongEmphasis: true,
    Emphasis: true,
    Strikethrough: true,
    Link: true,
    InlineCode: true,
    Autolink: true,
  };

  var INLINE_SPAN_CONFIG = {
    StrongEmphasis: { markName: 'EmphasisMark', className: 'cm-md-strong' },
    Emphasis: { markName: 'EmphasisMark', className: 'cm-md-em' },
    Strikethrough: { markName: 'StrikethroughMark', className: 'cm-md-strike' },
    InlineCode: { markName: 'CodeMark', className: 'cm-md-code' },
  };

  /**
   * Resolves the AGYCodeMirror bundle either from an explicit argument, global scope,
   * or CommonJS fallback when running headless tests in Node.
   * @param {object} [cm]
   * @returns {object | null}
   */
  function resolveCodeMirror(cm) {
    if (cm && typeof cm.syntaxTree === 'function') {
      return cm;
    }
    if (root && root.AGYCodeMirror && typeof root.AGYCodeMirror.syntaxTree === 'function') {
      return root.AGYCodeMirror;
    }
    if (
      root &&
      root.window &&
      root.window.AGYCodeMirror &&
      typeof root.window.AGYCodeMirror.syntaxTree === 'function'
    ) {
      return root.window.AGYCodeMirror;
    }
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.AGYCodeMirror &&
      typeof globalThis.AGYCodeMirror.syntaxTree === 'function'
    ) {
      return globalThis.AGYCodeMirror;
    }
    if (cachedCommonJsCm) {
      return cachedCommonJsCm;
    }
    if (typeof require === 'function') {
      try {
        var required = require('./vendor/cm6-bundle.js');
        if (required && typeof required.syntaxTree === 'function') {
          cachedCommonJsCm = required;
          return cachedCommonJsCm;
        }
      } catch (_err) {
        // Ignore and try loading classic bundle in a VM below.
      }
      if (typeof __dirname === 'string') {
        try {
          var fs = require('fs');
          var path = require('path');
          var vm = require('vm');
          var bundlePath = path.join(__dirname, 'vendor', 'cm6-bundle.js');
          var code = fs.readFileSync(bundlePath, 'utf8');
          var sandbox = { window: {}, globalThis: null, self: null, console: console };
          sandbox.globalThis = sandbox;
          sandbox.self = sandbox;
          vm.runInNewContext(code, sandbox, { filename: bundlePath });
          var loaded = sandbox.AGYCodeMirror || sandbox.window.AGYCodeMirror;
          if (loaded && typeof loaded.syntaxTree === 'function') {
            cachedCommonJsCm = loaded;
            return cachedCommonJsCm;
          }
        } catch (_err2) {
          return null;
        }
      }
    }
    return null;
  }

  function getUrlConstructor() {
    if (typeof URL === 'function') {
      return URL;
    }
    if (root && typeof root.URL === 'function') {
      return root.URL;
    }
    if (typeof require === 'function') {
      try {
        var urlMod = require('url');
        if (urlMod && typeof urlMod.URL === 'function') {
          return urlMod.URL;
        }
      } catch (_err) {
        return null;
      }
    }
    return null;
  }

  /**
   * Validates that a raw URL string uses strictly the http: or https: scheme.
   * Rejects javascript:, data:, file:, bare hostnames, and malformed URLs.
   * @param {unknown} rawUrl
   * @returns {boolean}
   */
  function isSafeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string') {
      return false;
    }
    var trimmed = rawUrl.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
      return false;
    }
    var UrlCtor = getUrlConstructor();
    if (UrlCtor) {
      try {
        var parsed = new UrlCtor(trimmed);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.host);
      } catch (_err) {
        return false;
      }
    }
    if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) {
      return false;
    }
    var match = trimmed.match(/^https?:\/\/([^/?#]+)(?:[/?#].*)?$/i);
    if (!match) {
      return false;
    }
    var authority = match[1];
    var atIdx = authority.lastIndexOf('@');
    var hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
    var host = hostPort.replace(/:\d+$/, '');
    return Boolean(host);
  }

  /**
   * Returns true if any range in the editor selection overlaps [from, to] inclusively.
   * @param {{ ranges?: Array<{ from: number, to: number }>, from?: number, to?: number }} selection
   * @param {number} from
   * @param {number} to
   * @returns {boolean}
   */
  function isSelectionInRange(selection, from, to) {
    if (!selection || typeof from !== 'number' || typeof to !== 'number' || from > to) {
      return false;
    }
    var ranges = Array.isArray(selection.ranges)
      ? selection.ranges
      : (typeof selection.from === 'number' && typeof selection.to === 'number' ? [selection] : null);
    if (!ranges) {
      return false;
    }
    for (var i = 0; i < ranges.length; i += 1) {
      var range = ranges[i];
      if (range && range.from <= to && range.to >= from) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if the editor selection touches any position on the given line.
   * @param {{ selection?: object }} state
   * @param {{ from: number, to: number }} line
   * @returns {boolean}
   */
  function isSelectionOnLine(state, line) {
    if (!state || !state.selection || !line) {
      return false;
    }
    return isSelectionInRange(state.selection, line.from, line.to);
  }

  function isHorizontalWhitespace(ch) {
    return ch === ' ' || ch === '\t';
  }

  function buildSafeLinkAttrs(url) {
    return {
      'data-md-href': url,
      title: 'Cmd/Ctrl+Click to open ' + url,
    };
  }

  function emitSyntaxOrHide(specs, from, to, revealed) {
    if (from >= to) {
      return;
    }
    if (revealed) {
      specs.push({ kind: 'mark', from: from, to: to, className: 'cm-md-syntax' });
    } else {
      specs.push({ kind: 'hide', from: from, to: to });
    }
  }

  function addHeadingSpecs(state, node, level, specs, addLineSpec) {
    var line = state.doc.lineAt(node.from);
    addLineSpec(line.from, 'cm-md-h' + level);
    var onLine = isSelectionOnLine(state, line);

    var child = node.firstChild;
    while (child) {
      if (child.name === 'HeaderMark') {
        if (child.from === node.from) {
          var openTo = child.to;
          if (openTo < line.to && isHorizontalWhitespace(state.sliceDoc(openTo, openTo + 1))) {
            openTo += 1;
          }
          emitSyntaxOrHide(specs, child.from, openTo, onLine);
        } else {
          var closeFrom = child.from;
          if (closeFrom > node.from && isHorizontalWhitespace(state.sliceDoc(closeFrom - 1, closeFrom))) {
            closeFrom -= 1;
          }
          emitSyntaxOrHide(specs, closeFrom, child.to, onLine);
        }
      }
      child = child.nextSibling;
    }
  }

  function addBlockquoteSpecs(state, node, addLineSpec) {
    var startNum = state.doc.lineAt(node.from).number;
    var endNum = state.doc.lineAt(node.to).number;
    for (var ln = startNum; ln <= endNum; ln += 1) {
      addLineSpec(state.doc.line(ln).from, 'cm-md-quote');
    }
  }

  function addQuoteMarkSpecs(state, node, specs, quoteLinePrefixEnd) {
    var line = state.doc.lineAt(node.from);
    var to = node.to;
    if (to < line.to && state.sliceDoc(to, to + 1) === ' ') {
      to += 1;
    }
    var prevEnd = quoteLinePrefixEnd.get(line.from) || line.from;
    if (to > prevEnd) {
      quoteLinePrefixEnd.set(line.from, to);
    }
    emitSyntaxOrHide(specs, node.from, to, isSelectionOnLine(state, line));
  }

  function addHorizontalRuleSpecs(state, node, specs, quoteLinePrefixEnd) {
    var line = state.doc.lineAt(node.from);
    var quoteEnd = quoteLinePrefixEnd.get(line.from);
    var from = quoteEnd && quoteEnd > line.from ? Math.max(quoteEnd, node.from) : line.from;
    var to = line.to;
    if (from >= to) {
      return;
    }
    if (isSelectionOnLine(state, line)) {
      specs.push({ kind: 'mark', from: from, to: to, className: 'cm-md-syntax' });
    } else {
      specs.push({ kind: 'widget', from: from, to: to, widget: 'hr' });
    }
  }

  function addInlineSpanSpecs(node, config, revealed, specs) {
    var marks = [];
    var child = node.firstChild;
    while (child) {
      if (child.name === config.markName) {
        marks.push({ from: child.from, to: child.to });
      }
      child = child.nextSibling;
    }
    if (marks.length < 2) {
      return;
    }
    var openMark = marks[0];
    var closeMark = marks[marks.length - 1];
    emitSyntaxOrHide(specs, openMark.from, openMark.to, revealed);
    if (openMark.to < closeMark.from) {
      specs.push({ kind: 'mark', from: openMark.to, to: closeMark.from, className: config.className });
    }
    emitSyntaxOrHide(specs, closeMark.from, closeMark.to, revealed);
  }

  function addLinkSpecs(state, node, revealed, specs) {
    var openBracket = null;
    var closeBracket = null;
    var openParen = null;
    var closeParen = null;
    var urlNode = null;
    var titleNode = null;

    var child = node.firstChild;
    while (child) {
      if (child.name === 'LinkMark') {
        var markText = state.sliceDoc(child.from, child.to);
        if (markText === '[' && !openBracket) {
          openBracket = child;
        } else if (markText === ']' && openBracket && !closeBracket) {
          closeBracket = child;
        } else if (markText === '(' && closeBracket && !openParen) {
          openParen = child;
        } else if (markText === ')' && openParen) {
          closeParen = child;
        }
      } else if (child.name === 'URL' && !urlNode) {
        urlNode = child;
      } else if (child.name === 'LinkTitle' && !titleNode) {
        titleNode = child;
      }
      child = child.nextSibling;
    }

    // Ignore shortcut/reference bracket constructs such as [plain text] or [Docs][ref].
    if (!openBracket || !closeBracket || !openParen || !closeParen) {
      return;
    }

    var rawUrl = urlNode ? state.sliceDoc(urlNode.from, urlNode.to) : '';
    if (rawUrl.length >= 2 && rawUrl.charAt(0) === '<' && rawUrl.charAt(rawUrl.length - 1) === '>') {
      rawUrl = rawUrl.slice(1, -1);
    }
    var safe = isSafeHttpUrl(rawUrl);

    if (openBracket.to < closeBracket.from) {
      var textSpec = {
        kind: 'mark',
        from: openBracket.to,
        to: closeBracket.from,
        className: 'cm-md-link',
      };
      if (safe) {
        textSpec.attrs = buildSafeLinkAttrs(rawUrl);
      }
      specs.push(textSpec);
    }

    if (!revealed) {
      specs.push({ kind: 'hide', from: openBracket.from, to: openBracket.to });
      specs.push({ kind: 'hide', from: closeBracket.from, to: closeParen.to });
      return;
    }

    specs.push({ kind: 'mark', from: openBracket.from, to: openBracket.to, className: 'cm-md-syntax' });
    specs.push({ kind: 'mark', from: closeBracket.from, to: openParen.to, className: 'cm-md-syntax' });
    if (urlNode && urlNode.from < urlNode.to) {
      specs.push({ kind: 'mark', from: urlNode.from, to: urlNode.to, className: 'cm-md-link-url' });
    }
    if (titleNode && titleNode.from < titleNode.to) {
      specs.push({ kind: 'mark', from: titleNode.from, to: titleNode.to, className: 'cm-md-syntax' });
    }
    specs.push({ kind: 'mark', from: closeParen.from, to: closeParen.to, className: 'cm-md-syntax' });
  }

  function addAutolinkSpecs(state, node, revealed, specs) {
    var openMark = null;
    var closeMark = null;
    var urlNode = null;

    var child = node.firstChild;
    while (child) {
      if (child.name === 'LinkMark') {
        var markText = state.sliceDoc(child.from, child.to);
        if (markText === '<') {
          openMark = child;
        } else if (markText === '>') {
          closeMark = child;
        }
      } else if (child.name === 'URL') {
        urlNode = child;
      }
      child = child.nextSibling;
    }

    if (urlNode && urlNode.from < urlNode.to) {
      var rawUrl = state.sliceDoc(urlNode.from, urlNode.to);
      var urlSpec = {
        kind: 'mark',
        from: urlNode.from,
        to: urlNode.to,
        className: 'cm-md-link',
      };
      if (isSafeHttpUrl(rawUrl)) {
        urlSpec.attrs = buildSafeLinkAttrs(rawUrl);
      }
      specs.push(urlSpec);
    }

    if (openMark) {
      emitSyntaxOrHide(specs, openMark.from, openMark.to, revealed);
    }
    if (closeMark) {
      emitSyntaxOrHide(specs, closeMark.from, closeMark.to, revealed);
    }
  }

  function addListItemSpecs(state, node, specs) {
    var listMark = null;
    var taskNode = null;
    var child = node.firstChild;
    while (child) {
      if (child.name === 'ListMark' && !listMark) {
        listMark = child;
      } else if (child.name === 'Task' && !taskNode) {
        taskNode = child;
      }
      child = child.nextSibling;
    }

    if (!listMark) {
      return;
    }

    if (taskNode) {
      var taskMarker = null;
      var taskChild = taskNode.firstChild;
      while (taskChild) {
        if (taskChild.name === 'TaskMarker') {
          taskMarker = taskChild;
          break;
        }
        taskChild = taskChild.nextSibling;
      }
      if (taskMarker) {
        var markerFrom = listMark.from;
        var markerTo = taskMarker.to;
        var markerText = state.sliceDoc(taskMarker.from, taskMarker.to);
        var checked = markerText === '[x]' || markerText === '[X]';

        if (isSelectionInRange(state.selection, markerFrom, markerTo)) {
          specs.push({ kind: 'mark', from: markerFrom, to: markerTo, className: 'cm-md-syntax' });
        } else {
          specs.push({
            kind: 'widget',
            from: markerFrom,
            to: markerTo,
            widget: 'checkbox',
            checked: checked,
            markerFrom: markerFrom,
            markerTo: markerTo,
          });
        }

        if (checked) {
          var bodyFrom = taskMarker.to;
          while (bodyFrom < taskNode.to && isHorizontalWhitespace(state.sliceDoc(bodyFrom, bodyFrom + 1))) {
            bodyFrom += 1;
          }
          if (bodyFrom < taskNode.to) {
            specs.push({ kind: 'mark', from: bodyFrom, to: taskNode.to, className: 'cm-md-task-done' });
          }
        }
        return;
      }
    }

    var markText = state.sliceDoc(listMark.from, listMark.to);
    if (markText === '-' || markText === '*' || markText === '+') {
      if (isSelectionInRange(state.selection, listMark.from, listMark.to)) {
        specs.push({ kind: 'mark', from: listMark.from, to: listMark.to, className: 'cm-md-syntax' });
      } else {
        specs.push({ kind: 'widget', from: listMark.from, to: listMark.to, widget: 'bullet' });
      }
    } else {
      specs.push({ kind: 'mark', from: listMark.from, to: listMark.to, className: 'cm-md-list-num' });
    }
  }

  function isOffsetInRanges(offset, ranges) {
    for (var i = 0; i < ranges.length; i += 1) {
      if (offset >= ranges[i].from && offset <= ranges[i].to) {
        return true;
      }
    }
    return false;
  }

  function addIndentGuideSpecs(state, listItems, quoteLinePrefixEnd, fencedRanges, specs) {
    var seenLines = new Set();
    for (var i = 0; i < listItems.length; i += 1) {
      var item = listItems[i];
      if (item.depth < 2) {
        continue;
      }
      var startLineNum = state.doc.lineAt(item.from).number;
      var endLineNum = state.doc.lineAt(item.to).number;
      for (var ln = startLineNum; ln <= endLineNum; ln += 1) {
        if (seenLines.has(ln)) {
          continue;
        }
        seenLines.add(ln);

        var line = state.doc.line(ln);
        var scanStart = quoteLinePrefixEnd.get(line.from) || line.from;
        var firstNonWs = scanStart;
        while (firstNonWs < line.to && isHorizontalWhitespace(state.sliceDoc(firstNonWs, firstNonWs + 1))) {
          firstNonWs += 1;
        }
        if (firstNonWs >= line.to || isOffsetInRanges(firstNonWs, fencedRanges)) {
          continue;
        }

        var depthAtContent = 0;
        for (var j = 0; j < listItems.length; j += 1) {
          var candidate = listItems[j];
          if (candidate.from <= firstNonWs && firstNonWs <= candidate.to && candidate.depth > depthAtContent) {
            depthAtContent = candidate.depth;
          }
        }

        var nestingDepth = depthAtContent - 1;
        if (nestingDepth <= 0) {
          continue;
        }

        var guidesEmitted = 0;
        var pos = scanStart;
        while (pos < firstNonWs && guidesEmitted < nestingDepth) {
          var ch = state.sliceDoc(pos, pos + 1);
          if (ch === '\t') {
            guidesEmitted += 1;
            specs.push({
              kind: 'widget',
              from: pos,
              to: pos,
              widget: 'indent-guide',
              depth: guidesEmitted,
            });
            pos += 1;
          } else if (pos + 1 < firstNonWs && state.sliceDoc(pos, pos + 2) === '  ') {
            guidesEmitted += 1;
            specs.push({
              kind: 'widget',
              from: pos,
              to: pos,
              widget: 'indent-guide',
              depth: guidesEmitted,
            });
            pos += 2;
          } else {
            break;
          }
        }
      }
    }
  }

  /**
   * Maps spec kind to a sort bucket matching CodeMirror 6 RangeSetBuilder startSide ordering:
   * line (-2e8) < point widget (-1e8) < replace/hide (499999999) < mark (500000000).
   */
  function specKindOrder(spec) {
    if (spec.kind === 'line') {
      return 0;
    }
    if (spec.kind === 'widget' && spec.from === spec.to) {
      return 1;
    }
    if (spec.kind === 'hide' || spec.kind === 'widget') {
      return 2;
    }
    return 3;
  }

  function compareSpecs(a, b) {
    var startA = a.kind === 'line' ? a.pos : a.from;
    var startB = b.kind === 'line' ? b.pos : b.from;
    if (startA !== startB) {
      return startA - startB;
    }
    var orderA = specKindOrder(a);
    var orderB = specKindOrder(b);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    var endA = a.kind === 'line' ? a.pos : a.to;
    var endB = b.kind === 'line' ? b.pos : b.to;
    if (endA !== endB) {
      return endA - endB;
    }
    var depthDiff = (a.depth || 0) - (b.depth || 0);
    if (depthDiff !== 0) {
      return depthDiff;
    }
    var labelA = a.className || a.widget || '';
    var labelB = b.className || b.widget || '';
    if (labelA < labelB) return -1;
    if (labelA > labelB) return 1;
    return 0;
  }

  /**
   * Computes sorted, deterministic Live Preview decoration specs for a CodeMirror Markdown state.
   * @param {object} state
   * @param {object} [cm]
   * @returns {Array<object>}
   */
  function computeLivePreviewSpecs(state, cm) {
    if (!state || !state.doc || state.doc.length === 0) {
      return [];
    }
    var resolvedCm = resolveCodeMirror(cm);
    if (!resolvedCm || typeof resolvedCm.syntaxTree !== 'function') {
      return [];
    }

    var tree = resolvedCm.syntaxTree(state);
    if (!tree) {
      return [];
    }

    var specs = [];
    var inlineRevealStack = [];
    var listItemDepth = 0;
    var listItems = [];
    var fencedRanges = [];
    var seenLineClasses = new Set();
    var quoteLinePrefixEnd = new Map();

    function addLineSpec(pos, className) {
      var key = pos + ':' + className;
      if (seenLineClasses.has(key)) {
        return;
      }
      seenLineClasses.add(key);
      specs.push({ kind: 'line', pos: pos, className: className });
    }

    tree.iterate({
      enter: function (nodeRef) {
        var name = nodeRef.name;

        if (name === 'FencedCode') {
          fencedRanges.push({ from: nodeRef.from, to: nodeRef.to });
          return false;
        }

        if (INLINE_CONTAINER_TYPES[name]) {
          var parentRevealed = inlineRevealStack.length > 0 && inlineRevealStack[inlineRevealStack.length - 1];
          var revealed = parentRevealed || isSelectionInRange(state.selection, nodeRef.from, nodeRef.to);
          inlineRevealStack.push(revealed);

          if (INLINE_SPAN_CONFIG[name]) {
            addInlineSpanSpecs(nodeRef.node, INLINE_SPAN_CONFIG[name], revealed, specs);
          } else if (name === 'Link') {
            addLinkSpecs(state, nodeRef.node, revealed, specs);
          } else if (name === 'Autolink') {
            addAutolinkSpecs(state, nodeRef.node, revealed, specs);
          }
          return;
        }

        if (name === 'ListItem') {
          listItemDepth += 1;
          listItems.push({ from: nodeRef.from, to: nodeRef.to, depth: listItemDepth });
          addListItemSpecs(state, nodeRef.node, specs);
          return;
        }

        if (name.indexOf('ATXHeading') === 0 && name.length === 11) {
          var level = name.charAt(10);
          if (level >= '1' && level <= '6') {
            addHeadingSpecs(state, nodeRef.node, level, specs, addLineSpec);
          }
          return;
        }

        if (name === 'Blockquote') {
          addBlockquoteSpecs(state, nodeRef.node, addLineSpec);
          return;
        }

        if (name === 'QuoteMark') {
          addQuoteMarkSpecs(state, nodeRef.node, specs, quoteLinePrefixEnd);
          return;
        }

        if (name === 'HorizontalRule') {
          addHorizontalRuleSpecs(state, nodeRef.node, specs, quoteLinePrefixEnd);
          return;
        }

        if (name === 'URL') {
          var parent = nodeRef.node.parent;
          if (!parent || (parent.name !== 'Link' && parent.name !== 'Autolink')) {
            var rawUrl = state.sliceDoc(nodeRef.from, nodeRef.to);
            if (isSafeHttpUrl(rawUrl)) {
              specs.push({
                kind: 'mark',
                from: nodeRef.from,
                to: nodeRef.to,
                className: 'cm-md-link',
                attrs: buildSafeLinkAttrs(rawUrl),
              });
            }
          }
        }
      },
      leave: function (nodeRef) {
        if (INLINE_CONTAINER_TYPES[nodeRef.name]) {
          inlineRevealStack.pop();
        } else if (nodeRef.name === 'ListItem') {
          listItemDepth -= 1;
        }
      },
    });

    addIndentGuideSpecs(state, listItems, quoteLinePrefixEnd, fencedRanges, specs);
    specs.sort(compareSpecs);
    return specs;
  }

  var DELIMITER_PAIRS = {
    '*': '*',
    '_': '_',
    '`': '`',
    '~': '~',
    '[': ']',
  };

  var CLAIMED_MOD_KEYS = {
    b: true,
    i: true,
    k: true,
    '`': true,
  };

  function isHorizontalRuleLine(text) {
    return /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(text);
  }

  function isInFencedCode(state, pos) {
    var resolvedCm = resolveCodeMirror();
    if (!resolvedCm || typeof resolvedCm.syntaxTree !== 'function') {
      return false;
    }
    var tree = resolvedCm.syntaxTree(state);
    if (!tree || typeof tree.resolveInner !== 'function') {
      return false;
    }
    var node = tree.resolveInner(pos, -1);
    while (node) {
      if (node.name === 'FencedCode') {
        return true;
      }
      node = node.parent;
    }
    return false;
  }

  function isEditorEditable(state, cm) {
    if (!state || state.readOnly) {
      return false;
    }
    var resolvedCm = resolveCodeMirror(cm);
    if (resolvedCm && resolvedCm.EditorView && resolvedCm.EditorView.editable && typeof state.facet === 'function') {
      return state.facet(resolvedCm.EditorView.editable) !== false;
    }
    return true;
  }

  function makeOrientedSelection(range, from, to) {
    if (range && range.anchor > range.head) {
      return { anchor: to, head: from };
    }
    return { anchor: from, head: to };
  }

  function matchListOrTaskPrefix(text) {
    if (isHorizontalRuleLine(text)) {
      return null;
    }
    var taskMatch = text.match(/^([ \t]*)([-*+])[ \t]+\[[ xX]\](?:[ \t]+|$)/);
    if (taskMatch) {
      return {
        kind: 'task',
        prefixLen: taskMatch[0].length,
        nextPrefix: taskMatch[1] + taskMatch[2] + ' [ ] ',
      };
    }
    var bulletMatch = text.match(/^([ \t]*)([-*+])[ \t]+/);
    if (bulletMatch) {
      return {
        kind: 'bullet',
        prefixLen: bulletMatch[0].length,
        nextPrefix: bulletMatch[1] + bulletMatch[2] + ' ',
      };
    }
    var orderedMatch = text.match(/^([ \t]*)(\d+)([.)])[ \t]+/);
    if (orderedMatch) {
      var nextNum = parseInt(orderedMatch[2], 10) + 1;
      return {
        kind: 'ordered',
        prefixLen: orderedMatch[0].length,
        nextPrefix: orderedMatch[1] + String(nextNum) + orderedMatch[3] + ' ',
      };
    }
    return null;
  }

  function buildInsertContinuationSpec(range, insertion) {
    return {
      changes: { from: range.from, to: range.to, insert: insertion },
      selection: { anchor: range.from + insertion.length },
      scrollIntoView: true,
      userEvent: 'input',
    };
  }

  function buildClearRangeSpec(from, to) {
    return {
      changes: { from: from, to: to, insert: '' },
      selection: { anchor: from },
      scrollIntoView: true,
      userEvent: 'delete',
    };
  }

  /**
   * Computes smart list / task / blockquote continuation or empty-prefix exit on Enter.
   * Returns null for plain lines, fenced code, multi-line selections, or cursor before prefix.
   * @param {object} state
   * @returns {object | null}
   */
  function computeSmartEnter(state) {
    if (!state || !state.doc || !state.selection || state.selection.ranges.length !== 1) {
      return null;
    }
    var range = state.selection.main;
    var line = state.doc.lineAt(range.from);
    if (range.to > line.to || isInFencedCode(state, range.from)) {
      return null;
    }

    var offset = range.from - line.from;
    var text = line.text;

    var quoteMatch = text.match(/^([ \t]*(?:>[ \t]?)+)/);
    if (quoteMatch) {
      var quotePrefix = quoteMatch[1];
      if (offset < quotePrefix.length) {
        return null;
      }
      var innerText = text.slice(quotePrefix.length);
      var innerList = matchListOrTaskPrefix(innerText);
      if (innerList) {
        var listOffset = offset - quotePrefix.length;
        if (listOffset < innerList.prefixLen) {
          return null;
        }
        if (innerText.slice(innerList.prefixLen).trim() === '') {
          return buildClearRangeSpec(line.from + quotePrefix.length, line.to);
        }
        return buildInsertContinuationSpec(range, '\n' + quotePrefix + innerList.nextPrefix);
      }
      if (innerText.trim() === '') {
        return buildClearRangeSpec(line.from, line.to);
      }
      var lastCh = quotePrefix.charAt(quotePrefix.length - 1);
      var normalizedQuote = isHorizontalWhitespace(lastCh) ? quotePrefix : quotePrefix + ' ';
      return buildInsertContinuationSpec(range, '\n' + normalizedQuote);
    }

    var listInfo = matchListOrTaskPrefix(text);
    if (!listInfo || offset < listInfo.prefixLen) {
      return null;
    }
    if (text.slice(listInfo.prefixLen).trim() === '') {
      return buildClearRangeSpec(line.from, line.to);
    }
    return buildInsertContinuationSpec(range, '\n' + listInfo.nextPrefix);
  }

  /**
   * Indents or outdents list lines (bullet, ordered, task) by 2 spaces (or leading tab).
   * Returns null outside list lines so Tab / Shift-Tab lets focus escape the editor naturally.
   * @param {object} state
   * @param {boolean} [outdent]
   * @returns {object | null}
   */
  function computeSmartTab(state, outdent) {
    if (!state || !state.doc || !state.selection) {
      return null;
    }
    var range = state.selection.main;
    var startLineNum = state.doc.lineAt(range.from).number;
    var endLineNum = state.doc.lineAt(range.to).number;
    if (!range.empty && endLineNum > startLineNum && range.to === state.doc.line(endLineNum).from) {
      endLineNum -= 1;
    }

    var listLines = [];
    for (var ln = startLineNum; ln <= endLineNum; ln += 1) {
      var line = state.doc.line(ln);
      if (isInFencedCode(state, line.from)) {
        return null;
      }
      if (matchListOrTaskPrefix(line.text)) {
        listLines.push(line);
      } else if (startLineNum === endLineNum || line.text.trim() !== '') {
        return null;
      }
    }

    if (listLines.length === 0) {
      return null;
    }

    var changes = [];
    for (var i = 0; i < listLines.length; i += 1) {
      var targetLine = listLines[i];
      if (!outdent) {
        changes.push({ from: targetLine.from, to: targetLine.from, insert: '  ' });
      } else if (targetLine.text.charAt(0) === '\t') {
        changes.push({ from: targetLine.from, to: targetLine.from + 1, insert: '' });
      } else if (targetLine.text.slice(0, 2) === '  ') {
        changes.push({ from: targetLine.from, to: targetLine.from + 2, insert: '' });
      } else if (targetLine.text.charAt(0) === ' ') {
        changes.push({ from: targetLine.from, to: targetLine.from + 1, insert: '' });
      }
    }

    if (changes.length === 0) {
      return null;
    }

    var changeSet = state.changes(changes);
    return {
      changes: changes,
      selection: state.selection.map(changeSet, outdent ? -1 : 1),
      scrollIntoView: true,
      userEvent: outdent ? 'delete' : 'input',
    };
  }

  function countContiguousChars(docSliceFn, startPos, step, ch, limit) {
    var count = 0;
    var pos = startPos;
    while (pos >= 0 && pos < limit) {
      var nextPos = step > 0 ? pos : pos - 1;
      if (nextPos < 0 || nextPos + 1 > limit || docSliceFn(nextPos, nextPos + 1) !== ch) {
        break;
      }
      count += 1;
      pos += step;
    }
    return count;
  }

  function hasBalancedSingleStarOutside(state, from, to) {
    var docLen = state.doc.length;
    var slice = function (a, b) {
      return state.sliceDoc(a, b);
    };
    var beforeCount = countContiguousChars(slice, from, -1, '*', docLen);
    var afterCount = countContiguousChars(slice, to, 1, '*', docLen);
    // Avoid misclassifying **bold** delimiters (2 stars) as *italic* wrappers.
    return (beforeCount % 2 === 1) && (afterCount % 2 === 1);
  }

  /**
   * Toggles inline Markdown delimiter wrapping (**, *, `, etc.) around the selection
   * or inserts a centered empty delimiter pair at a collapsed cursor.
   * @param {object} state
   * @param {string} marker
   * @returns {object}
   */
  function computeToggleInlineWrap(state, marker) {
    if (!state || !state.doc || !state.selection || typeof marker !== 'string' || !marker) {
      return { changes: [] };
    }
    var range = state.selection.main;
    var mLen = marker.length;

    if (range.empty) {
      return {
        changes: { from: range.from, to: range.to, insert: marker + marker },
        selection: { anchor: range.from + mLen },
        scrollIntoView: true,
        userEvent: 'input',
      };
    }

    var from = range.from;
    var to = range.to;
    var docLen = state.doc.length;

    var hasOutside =
      from >= mLen &&
      to + mLen <= docLen &&
      state.sliceDoc(from - mLen, from) === marker &&
      state.sliceDoc(to, to + mLen) === marker &&
      (marker !== '*' || hasBalancedSingleStarOutside(state, from, to));

    if (hasOutside) {
      return {
        changes: [
          { from: from - mLen, to: from, insert: '' },
          { from: to, to: to + mLen, insert: '' },
        ],
        selection: makeOrientedSelection(range, from - mLen, to - mLen),
        scrollIntoView: true,
        userEvent: 'delete',
      };
    }

    var selected = state.sliceDoc(from, to);
    if (selected.length >= mLen * 2 && selected.slice(0, mLen) === marker && selected.slice(selected.length - mLen) === marker) {
      var canUnwrapInside = false;
      if (marker === '*') {
        var lead = 0;
        var trail = 0;
        while (lead < selected.length && selected.charAt(lead) === '*') lead += 1;
        while (trail < selected.length && selected.charAt(selected.length - 1 - trail) === '*') trail += 1;
        canUnwrapInside =
          (lead % 2 === 1) &&
          (trail % 2 === 1) &&
          lead + trail <= selected.length &&
          selected.slice(lead, selected.length - trail).indexOf('*') === -1;
      } else {
        canUnwrapInside = selected.slice(mLen, selected.length - mLen).indexOf(marker) === -1;
      }

      if (canUnwrapInside) {
        return {
          changes: [
            { from: from, to: from + mLen, insert: '' },
            { from: to - mLen, to: to, insert: '' },
          ],
          selection: makeOrientedSelection(range, from, to - mLen * 2),
          scrollIntoView: true,
          userEvent: 'delete',
        };
      }
    }

    return {
      changes: [
        { from: from, to: from, insert: marker },
        { from: to, to: to, insert: marker },
      ],
      selection: makeOrientedSelection(range, from + mLen, to + mLen),
      scrollIntoView: true,
      userEvent: 'input',
    };
  }

  /**
   * Inserts a Markdown link template based on selection:
   * - safe http(s) URL -> `[](url)` with cursor inside `[]`
   * - non-URL text -> `[text](url)` with `url` selected
   * - empty selection -> `[](url)` with cursor inside `[]`
   * @param {object} state
   * @returns {object}
   */
  function computeInsertLink(state) {
    if (!state || !state.doc || !state.selection) {
      return { changes: [] };
    }
    var range = state.selection.main;
    var from = range.from;
    var to = range.to;

    if (range.empty) {
      return {
        changes: { from: from, to: to, insert: '[](url)' },
        selection: { anchor: from + 1 },
        scrollIntoView: true,
        userEvent: 'input',
      };
    }

    var selected = state.sliceDoc(from, to);
    if (isSafeHttpUrl(selected)) {
      var cleanUrl = selected.trim();
      return {
        changes: { from: from, to: to, insert: '[](' + cleanUrl + ')' },
        selection: { anchor: from + 1 },
        scrollIntoView: true,
        userEvent: 'input',
      };
    }

    var inserted = '[' + selected + '](url)';
    var urlStart = from + 1 + selected.length + 2;
    return {
      changes: { from: from, to: to, insert: inserted },
      selection: { anchor: urlStart, head: urlStart + 3 },
      scrollIntoView: true,
      userEvent: 'input',
    };
  }

  /**
   * Wraps a non-empty selection when typing *, _, `, ~, or [ (closing with ]).
   * Returns null on empty selection, invalid range, or non-delimiter text.
   * @param {object} state
   * @param {number} from
   * @param {number} to
   * @param {string} text
   * @returns {object | null}
   */
  function computeDelimiterWrap(state, from, to, text) {
    if (
      !state ||
      !state.doc ||
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      from < 0 ||
      to > state.doc.length ||
      from >= to ||
      typeof text !== 'string' ||
      !Object.prototype.hasOwnProperty.call(DELIMITER_PAIRS, text)
    ) {
      return null;
    }

    var close = DELIMITER_PAIRS[text];
    var main = state.selection ? state.selection.main : null;
    var sel = main && main.from === from && main.to === to
      ? makeOrientedSelection(main, from + 1, to + 1)
      : { anchor: from + 1, head: to + 1 };

    return {
      changes: [
        { from: from, to: from, insert: text },
        { from: to, to: to, insert: close },
      ],
      selection: sel,
      scrollIntoView: true,
      userEvent: 'input',
    };
  }

  /**
   * Toggles a Markdown task checkbox marker (`[ ]` <-> `[x]`, `[X]` -> `[ ]`).
   * Accepts either the 3-char bracket range `[ ]` or full list+task prefix `- [ ]`.
   * @param {object} state
   * @param {number} markerFrom
   * @param {number} markerTo
   * @returns {object | null}
   */
  function computeToggleTask(state, markerFrom, markerTo) {
    if (
      !isEditorEditable(state) ||
      !state.doc ||
      typeof markerFrom !== 'number' ||
      typeof markerTo !== 'number' ||
      markerFrom < 0 ||
      markerTo > state.doc.length ||
      markerFrom >= markerTo
    ) {
      return null;
    }

    var slice = state.sliceDoc(markerFrom, markerTo);
    var bracketFrom = -1;
    var bracketText = '';

    if (/^\[[ xX]\]$/.test(slice)) {
      bracketFrom = markerFrom;
      bracketText = slice;
    } else {
      var prefixMatch = slice.match(/^[-*+][ \t]+(\[[ xX]\])$/);
      if (prefixMatch) {
        bracketText = prefixMatch[1];
        bracketFrom = markerTo - 3;
      }
    }

    if (bracketFrom < 0) {
      return null;
    }

    var nextChar = bracketText === '[ ]' ? 'x' : ' ';
    return {
      changes: { from: bracketFrom + 1, to: bracketFrom + 2, insert: nextChar },
      userEvent: 'input',
    };
  }

  function isClaimedModShortcut(event) {
    if (!event || event.altKey || event.shiftKey) {
      return false;
    }
    var hasMod;
    if (typeof navigator !== 'undefined' && typeof navigator.platform === 'string') {
      var isMac = /Mac|iPod|iPhone|iPad/i.test(navigator.platform);
      hasMod = isMac ? (Boolean(event.metaKey) && !event.ctrlKey) : (Boolean(event.ctrlKey) && !event.metaKey);
    } else {
      hasMod = Boolean(event.metaKey) !== Boolean(event.ctrlKey);
    }
    if (!hasMod) {
      return false;
    }
    var key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(CLAIMED_MOD_KEYS, key) || event.code === 'Backquote';
  }

  function makeCommandHandler(resolvedCm, computeFn) {
    return function (view) {
      if (!view || !isEditorEditable(view.state, resolvedCm)) {
        return false;
      }
      var spec = computeFn(view.state);
      if (!spec) {
        return false;
      }
      view.dispatch(spec);
      return true;
    };
  }

  /**
   * Builds the high-precedence Obsidian keymap extension and pre-bubble keydown guard
   * preventing /preload.js from forwarding claimed modifier chords to the AGY Hub.
   * @param {object} [cm]
   * @returns {Array<object>}
   */
  function createNotesKeymap(cm) {
    var resolvedCm = resolveCodeMirror(cm);
    if (!resolvedCm || !resolvedCm.keymap || !resolvedCm.Prec || !resolvedCm.EditorView) {
      return [];
    }

    var bindings = [
      { key: 'Enter', run: makeCommandHandler(resolvedCm, computeSmartEnter) },
      { key: 'Tab', run: makeCommandHandler(resolvedCm, function (s) { return computeSmartTab(s, false); }) },
      { key: 'Shift-Tab', run: makeCommandHandler(resolvedCm, function (s) { return computeSmartTab(s, true); }) },
      { key: 'Mod-b', run: makeCommandHandler(resolvedCm, function (s) { return computeToggleInlineWrap(s, '**'); }) },
      { key: 'Mod-i', run: makeCommandHandler(resolvedCm, function (s) { return computeToggleInlineWrap(s, '*'); }) },
      { key: 'Mod-`', run: makeCommandHandler(resolvedCm, function (s) { return computeToggleInlineWrap(s, '`'); }) },
      { key: 'Mod-k', run: makeCommandHandler(resolvedCm, computeInsertLink) },
    ];

    // @codemirror/lang-markdown registers its own Enter binding at Prec.high; Prec.highest
    // ensures our smart list/task Enter and Tab passthrough run first regardless of extension order.
    var extensions = [resolvedCm.Prec.highest(resolvedCm.keymap.of(bindings))];
    if (typeof resolvedCm.EditorView.domEventHandlers === 'function') {
      extensions.push(resolvedCm.EditorView.domEventHandlers({
        keydown: function (event, view) {
          if (view && isEditorEditable(view.state, resolvedCm) && isClaimedModShortcut(event)) {
            if (typeof event.preventDefault === 'function') {
              event.preventDefault();
            }
          }
          return false;
        },
      }));
    }
    return extensions;
  }

  return {
    isSafeHttpUrl: isSafeHttpUrl,
    isSelectionInRange: isSelectionInRange,
    isSelectionOnLine: isSelectionOnLine,
    computeLivePreviewSpecs: computeLivePreviewSpecs,
    computeSmartEnter: computeSmartEnter,
    computeSmartTab: computeSmartTab,
    computeToggleInlineWrap: computeToggleInlineWrap,
    computeInsertLink: computeInsertLink,
    computeDelimiterWrap: computeDelimiterWrap,
    computeToggleTask: computeToggleTask,
    createNotesKeymap: createNotesKeymap,
  };
});
