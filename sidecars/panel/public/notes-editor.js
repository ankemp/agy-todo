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

  return {
    isSafeHttpUrl: isSafeHttpUrl,
    isSelectionInRange: isSelectionInRange,
    isSelectionOnLine: isSelectionOnLine,
    computeLivePreviewSpecs: computeLivePreviewSpecs,
  };
});
