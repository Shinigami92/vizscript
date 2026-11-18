import {
  ADD_PIN_LABEL,
  compactTitle,
  containerPinOf,
  headerIcon,
  ICON_SPACE,
  isCompact,
  isContainerNode,
  isLatent,
  isMathNode,
  isSetter,
  NODE_METRICS,
  pinColor,
  pinKey,
  pinLabel,
} from '@vizscript/core';
import type { Pin, PinGeometry } from '@vizscript/core';
import {
  BUBBLE_GAP,
  BUBBLE_LINE_HEIGHT,
  BUBBLE_PADDING_X,
  BUBBLE_PADDING_Y,
} from './bubble';
import { easeOut } from './camera';
import {
  containerShape,
  drawContainerPin,
  drawContainerSymbol,
} from './container-shapes';
import type { FontMetrics } from './font-metrics';
import {
  ADVANCED_ROW,
  BANNER_GAP,
  BANNER_HEIGHT,
  isChecked,
  NODE_APPEAR_MS,
  NODE_PULSE_MS,
} from './graph-view-constants';
import type { NodeState } from './graph-view-types';
import type { NodePainter } from './node-decor';
import {
  drawCheckbox,
  drawClock,
  drawHeaderIcon,
  drawPillGlow,
  drawRim,
  drawSetGlow,
  drawSetTitle,
} from './node-decor';
import type { RenderFrame } from './render-frame';
import type { Scene } from './scene';
import type { Theme } from './theme';
import type { Viewport } from './viewport';

/** Drawing of nodes: body, header, pins, values, bubbles, banners. */
export class NodeRenderer {
  private state!: RenderFrame;

  public constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly metrics: FontMetrics,
    private readonly scene: Scene,
    private readonly viewport: Viewport,
    private theme: Theme
  ) {}

  public setTheme(theme: Theme): void {
    this.theme = theme;
  }

  /** What the node drawing helpers of `node-decor.ts` draw with. */
  private painter(): NodePainter {
    return {
      ctx: this.ctx,
      theme: this.theme,
      font: (style) => this.metrics.font(style),
      scale: this.viewport.camera.zoom * this.viewport.dpr,
    };
  }

  /** A node, faded and grown in while it appears, then its pulse. */
  public draw(ns: NodeState, state: RenderFrame): void {
    this.state = state;
    const { ctx } = this;
    if (ns.appear === undefined) {
      this.drawNode(ns);
    } else {
      const k = easeOut((this.state.time - ns.appear) / NODE_APPEAR_MS);
      const cx = ns.x + ns.geom.width / 2;
      const cy = ns.y + ns.geom.height / 2;
      const scale = 0.94 + 0.06 * k;
      ctx.save();
      ctx.globalAlpha = k;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
      this.drawNode(ns);
      ctx.restore();
    }

    if (ns.pulse !== undefined) {
      const k = easeOut((this.state.time - ns.pulse) / NODE_PULSE_MS);
      const grow = 4 + 14 * k;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.beginPath();
      ctx.roundRect(
        ns.x - grow,
        ns.y - grow,
        ns.geom.width + grow * 2,
        ns.geom.height + grow * 2,
        NODE_METRICS.cornerRadius + grow
      );
      ctx.strokeStyle = this.theme.selection;
      ctx.lineWidth = 2.5 / Math.max(this.viewport.camera.zoom, 0.4);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawNode(ns: NodeState): void {
    const { ctx, theme } = this;
    const { node, geom } = ns;
    const lod = this.viewport.camera.zoom < 0.4;
    const compact = isCompact(node);
    const math = isMathNode(node);
    // UE's Get pill: a dark capsule lit by its type's color.
    const getPill =
      compact &&
      !math &&
      ((node.category === 'variable' && node.kind !== 'setVar') ||
        node.kind === 'getProperty');
    const setter = isSetter(node);
    // UE's pills are rounded rectangles, not full capsules.
    const r = getPill
      ? Math.min(geom.height * 0.36, 14)
      : math
        ? 4
        : compact
          ? Math.min(geom.height / 2, 14)
          : NODE_METRICS.cornerRadius;
    const id = node.id;

    this.drawBubble(ns, lod);
    if (compact) {
      // Below a compact node: drawn before it.
      this.drawProblemBanner(ns, lod);
    }

    // A soft drop shadow like UE's (not at overview zoom), only outside the
    // node: the body is see-through and must not darken over it.
    if (!lod) {
      const scale = this.viewport.camera.zoom * this.viewport.dpr;
      const margin = 40;
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        ns.x - margin,
        ns.y - margin,
        geom.width + margin * 2,
        geom.height + margin * 2
      );
      ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
      ctx.clip('evenodd');
      ctx.shadowColor = theme.nodeShadow;
      ctx.shadowBlur = 14 * scale;
      ctx.shadowOffsetY = 3 * scale;
      ctx.beginPath();
      ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
      ctx.fillStyle = theme.background;
      ctx.fill();
      ctx.restore();
    }

    // Body
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
    if (math) {
      const body = ctx.createLinearGradient(
        ns.x,
        ns.y,
        ns.x,
        ns.y + geom.height
      );
      body.addColorStop(0, theme.mathTop);
      body.addColorStop(1, theme.mathBottom);
      ctx.fillStyle = body;
    } else if (compact) {
      ctx.fillStyle = getPill
        ? theme.pillBody
        : node.category === 'variable'
          ? theme.compactVariable
          : node.purity === 'pure'
            ? theme.compactPure
            : theme.nodeBody;
    } else {
      ctx.fillStyle = theme.nodeBody;
    }

    ctx.fill();
    ctx.restore();

    if (getPill && !lod) {
      drawPillGlow(this.painter(), ns, r);
    } else if (setter && !lod) {
      drawSetGlow(this.painter(), ns, r);
    }

    // Header
    if (!compact) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(ns.x, ns.y, geom.width, geom.headerHeight, [r, r, 0, 0]);
      ctx.clip();
      const gradient = ctx.createLinearGradient(
        ns.x,
        ns.y,
        ns.x + geom.width,
        ns.y
      );
      const color = theme.categories[node.category];
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, `${color}${theme.headerFade}`);
      ctx.fillStyle = gradient;
      ctx.fillRect(ns.x, ns.y, geom.width, geom.headerHeight);
      // UE's gloss: a light top edge and a dark line under the header.
      const shine = ctx.createLinearGradient(
        ns.x,
        ns.y,
        ns.x,
        ns.y + geom.headerHeight
      );
      shine.addColorStop(0, theme.headerShine);
      shine.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = shine;
      ctx.fillRect(ns.x, ns.y, geom.width, geom.headerHeight);
      ctx.fillStyle = theme.headerDivider;
      ctx.fillRect(ns.x, ns.y + geom.headerHeight - 1, geom.width, 1);
      ctx.restore();
    } else if (node.category !== 'variable' && !math && !getPill) {
      ctx.beginPath();
      ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
      ctx.strokeStyle = `${theme.categories[node.category]}cc`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (!compact) {
      // Under the header, over the body.
      this.drawProblemBanner(ns, lod);
    }

    // Outline
    const selected = this.state.selection.has(id);
    const highlighted = this.state.highlight.has(id);
    const hovered = this.state.hoverNode === id;
    ctx.beginPath();
    ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
    if (selected || highlighted || hovered) {
      ctx.strokeStyle = selected
        ? theme.selection
        : highlighted
          ? theme.codeHighlight
          : theme.hover;
      ctx.lineWidth = selected || highlighted ? 2.5 : 1.5;
    } else if (this.scene.problems.get(id) === 'sync') {
      // Not in the code yet: a dashed outline like the banner.
      ctx.strokeStyle = theme.syncBanner;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
    } else {
      ctx.strokeStyle = theme.nodeBorder;
      ctx.lineWidth = 1.5;
    }

    ctx.stroke();
    ctx.setLineDash([]);
    if (!lod && !selected && !highlighted) {
      drawRim(this.painter(), ns, r, getPill);
    }

    // Title
    ctx.textBaseline = 'middle';
    if (compact) {
      ctx.font = this.metrics.font('compact');
      ctx.fillStyle = theme.nodeText;
      ctx.textAlign = 'center';
      const left =
        geom.leftColumn > 0 ? geom.leftColumn + 4 : NODE_METRICS.paddingX;
      const right =
        geom.rightColumn > 0 ? geom.rightColumn + 4 : NODE_METRICS.paddingX;
      // Math glyphs sit in the middle of the node, behind pins and values.
      const centerX =
        math && !isContainerNode(node)
          ? ns.x + geom.width / 2
          : ns.x + (left + geom.width - right) / 2;
      // A setter shows `SET` and, small below, how it declares (`const`).
      const sub = node.subtitle && !lod ? node.subtitle : '';
      const centerY = ns.y + (geom.glyphY ?? geom.height / 2) - (sub ? 6 : 0);
      if (math) {
        const target = isContainerNode(node) ? containerPinOf(node) : undefined;
        if (target && !lod) {
          drawContainerSymbol(
            ctx,
            centerX,
            centerY,
            Math.min(geom.height - 10, 34),
            target.type,
            theme.scheme
          );
        }

        // UE's big faded glyph or word, behind the pins and values.
        ctx.font = this.metrics.font('glyph');
        ctx.fillStyle = theme.operatorGlyph;
      }

      if (setter) {
        // UE's SET node: the title centered in the exec row.
        drawSetTitle(this.painter(), ns, sub);
      } else if (getPill) {
        // The name sits next to the pin, with a shadow like UE's.
        ctx.save();
        ctx.textAlign = 'right';
        // UE's pill names are regular weight.
        ctx.font = `500 13px ${theme.fontFamily}`;
        // Light text on the dark pill; dark text needs no shadow.
        if (!lod && theme.scheme === 'dark') {
          const scale = this.viewport.camera.zoom * this.viewport.dpr;
          ctx.shadowColor = theme.titleShadow;
          ctx.shadowBlur = 2 * scale;
          ctx.shadowOffsetY = 1 * scale;
        }

        ctx.fillText(compactTitle(node), ns.x + geom.width - right, centerY);
        ctx.restore();
      } else {
        ctx.fillText(compactTitle(node), centerX, centerY);
      }

      if (sub && !setter) {
        ctx.font = this.metrics.font('subtitle');
        ctx.fillStyle = theme.compactSubtext;
        ctx.fillText(sub, centerX, centerY + 14);
      }
    } else {
      const icon = lod ? undefined : headerIcon(node);
      const titleY = ns.y + NODE_METRICS.headerHeight / 2 + 1;
      if (icon) {
        drawHeaderIcon(
          this.painter(),
          icon,
          ns.x + NODE_METRICS.paddingX + 6,
          titleY,
          theme.nodeTitle
        );
      }

      if (isLatent(node) && !lod) {
        drawClock(
          this.painter(),
          ns.x + geom.width - NODE_METRICS.paddingX - 6,
          titleY,
          theme.nodeTitle
        );
      }

      ctx.font = this.metrics.font('title');
      ctx.fillStyle = theme.nodeTitle;
      ctx.textAlign = 'left';
      ctx.save();
      if (!lod) {
        const scale = this.viewport.camera.zoom * this.viewport.dpr;
        ctx.shadowColor = theme.titleShadow;
        ctx.shadowBlur = 2 * scale;
        ctx.shadowOffsetY = 1 * scale;
      }

      ctx.fillText(
        node.title,
        ns.x + NODE_METRICS.paddingX + (icon ? ICON_SPACE : 0),
        titleY
      );
      ctx.restore();
      if (node.subtitle && !lod) {
        ctx.font = this.metrics.font('subtitle');
        ctx.fillStyle = theme.nodeSubtext;
        ctx.fillText(
          node.subtitle,
          ns.x + NODE_METRICS.paddingX,
          ns.y + NODE_METRICS.headerHeight + NODE_METRICS.subtitleHeight / 2 - 4
        );
      }
    }

    // Pins
    for (const pg of geom.pins.values()) {
      this.drawPin(ns, pg, lod);
    }

    if (ns.advanced > 0 && !lod) {
      this.drawAdvancedToggle(ns);
    }

    if (ns.geom.addPin && this.state.editable && !lod) {
      this.drawAddPin(ns, ns.geom.addPin);
    }
  }

  /** UE's "Add pin ⊕" in the lower right corner. */
  private drawAddPin(
    ns: NodeState,
    button: { x: number; y: number; width: number }
  ): void {
    const { ctx, theme } = this;
    const hovered = this.state.hoverAddPin === ns.node.id;
    const color = hovered ? theme.nodeText : theme.pinLabel;
    const x = ns.x + button.x;
    const y = ns.y + button.y;
    ctx.font = this.metrics.font('label');
    ctx.fillStyle = color;
    ctx.globalAlpha = hovered ? 1 : 0.75;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(ADD_PIN_LABEL, x, y);
    // ⊕ after the text.
    const r = NODE_METRICS.pinRadius + 1;
    const cx = x + button.width - r - 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, y, r, 0, Math.PI * 2);
    ctx.moveTo(cx - r + 2.5, y);
    ctx.lineTo(cx + r - 2.5, y);
    ctx.moveTo(cx, y - r + 2.5);
    ctx.lineTo(cx, y + r - 2.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** UE's ▼ under a node with folded advanced pins (▲ when shown). */
  private drawAdvancedToggle(ns: NodeState): void {
    const { ctx, theme } = this;
    const x = ns.x + ns.geom.width / 2;
    const y = ns.y + ns.geom.height - ADVANCED_ROW / 2 - 1;
    const open = this.scene.expandedNodes.has(ns.full.id);
    const hovered = this.state.hoverNode === ns.node.id;
    ctx.beginPath();
    if (open) {
      ctx.moveTo(x - 5, y + 2.5);
      ctx.lineTo(x + 5, y + 2.5);
      ctx.lineTo(x, y - 2.5);
    } else {
      ctx.moveTo(x - 5, y - 2.5);
      ctx.lineTo(x + 5, y - 2.5);
      ctx.lineTo(x, y + 2.5);
    }

    ctx.closePath();
    ctx.fillStyle = hovered ? theme.nodeText : theme.pinLabel;
    ctx.globalAlpha = hovered ? 1 : 0.6;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawPin(ns: NodeState, pg: PinGeometry, lod: boolean): void {
    const { ctx, theme } = this;
    const pin: Pin = pg.pin;
    const p = this.scene.pinWorld(ns, pg);
    const connected = this.scene.connectedPins.has(
      pinKey({ node: ns.node.id, pin: pin.id })
    );
    const hovered =
      this.state.hoverNode === ns.node.id && this.state.hoverPin === pin.id;
    const r = NODE_METRICS.pinRadius + (hovered ? 1.5 : 0);

    if (pin.kind === 'exec') {
      ctx.beginPath();
      ctx.moveTo(p.x - r, p.y - r - 1);
      ctx.lineTo(p.x + 1, p.y - r - 1);
      ctx.lineTo(p.x + r + 1, p.y);
      ctx.lineTo(p.x + 1, p.y + r + 1);
      ctx.lineTo(p.x - r, p.y + r + 1);
      ctx.closePath();
      ctx.strokeStyle = theme.exec;
      ctx.lineWidth = 1.6;
      if (connected) {
        ctx.fillStyle = theme.exec;
        ctx.fill();
      }

      ctx.stroke();
    } else {
      const color = pinColor(pin.type, theme.scheme);
      if (containerShape(pin.type)) {
        drawContainerPin(
          ctx,
          p.x,
          p.y,
          r * 2 + 2,
          pin.type,
          theme.scheme,
          connected
        );
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        if (connected) {
          ctx.fillStyle = color;
          ctx.fill();
        }

        ctx.stroke();
        if (!lod) {
          // UE's small arrow after a data pin, in the direction of flow.
          const ax = p.x + r + 2;
          ctx.beginPath();
          ctx.moveTo(ax, p.y - 2.5);
          ctx.lineTo(ax + 3, p.y);
          ctx.lineTo(ax, p.y + 2.5);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
    }

    if (lod) {
      return;
    }

    const labelX =
      pg.side === 'left'
        ? p.x + NODE_METRICS.pinRadius + NODE_METRICS.pinLabelGap
        : p.x - NODE_METRICS.pinRadius - NODE_METRICS.pinLabelGap;
    const label = pinLabel(ns.node, pin);
    if (label) {
      ctx.font = this.metrics.font('label');
      ctx.fillStyle = theme.pinLabel;
      ctx.textAlign = pg.side === 'left' ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, labelX, p.y);
    }

    const lr = this.scene.literalRect(ns, pg);
    if (lr && pin.literal?.kind === 'boolean') {
      drawCheckbox(this.painter(), lr, isChecked(pin.literal.value));
    } else if (lr && pin.literal) {
      // UE's value box: dark, nearly square, with a thin light border.
      ctx.beginPath();
      ctx.roundRect(lr.x + 0.5, lr.y + 0.5, lr.width - 1, lr.height - 1, 2);
      ctx.fillStyle = theme.literalBackground;
      ctx.fill();
      ctx.strokeStyle = theme.literalBorder;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.rect(lr.x + 4, lr.y, lr.width - 8, lr.height);
      ctx.clip();
      ctx.font = this.metrics.font('literal');
      ctx.fillStyle =
        pin.literal.kind === 'string' || pin.literal.kind === 'template'
          ? theme.literalString
          : theme.literalText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        pin.literal.value || ' ',
        lr.x + NODE_METRICS.literalPadding,
        p.y + 0.5
      );
      ctx.restore();
    }
  }

  /** UE's ERROR / WARNING / NOT IN CODE banner under a node. */
  private drawProblemBanner(ns: NodeState, lod: boolean): void {
    const severity = this.scene.problems.get(ns.node.id);
    if (!severity) {
      return;
    }

    const { ctx, theme } = this;
    // Like UE: a band across the node right under its header; compact
    // nodes (no header) get it below them.
    const inside = !isCompact(ns.node);
    const y = inside
      ? ns.y + ns.geom.headerHeight
      : ns.y + ns.geom.height + BANNER_GAP;
    const color =
      severity === 'error'
        ? theme.errorBanner
        : severity === 'warning'
          ? theme.warningBanner
          : severity === 'sync'
            ? theme.syncBanner
            : theme.infoBanner;
    ctx.beginPath();
    if (inside) {
      ctx.rect(ns.x, y, ns.geom.width, BANNER_HEIGHT);
    } else {
      ctx.roundRect(ns.x, y, ns.geom.width, BANNER_HEIGHT, 4);
    }

    ctx.fillStyle = color;
    ctx.fill();
    if (lod) {
      return;
    }

    ctx.fillStyle =
      severity === 'warning' ? theme.warningBannerText : theme.bannerText;
    ctx.font = `700 11px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(
      severity === 'error'
        ? 'ERROR!'
        : severity === 'warning'
          ? 'WARNING!'
          : severity === 'sync'
            ? 'NOT IN CODE'
            : 'NOTE',
      ns.x + ns.geom.width / 2,
      y + BANNER_HEIGHT / 2 + 0.5
    );
  }

  private drawBubble(ns: NodeState, lod: boolean): void {
    const r = this.scene.bubbleRect(ns);
    const bubble = ns.bubble;
    if (!r || !bubble) {
      return;
    }

    const { ctx, theme } = this;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.width, r.height, 5);
    // Tail pointing at the node.
    const tailX = r.x + 16;
    ctx.moveTo(tailX - 6, r.y + r.height);
    ctx.lineTo(tailX, r.y + r.height + BUBBLE_GAP - 2);
    ctx.lineTo(tailX + 6, r.y + r.height);
    ctx.fillStyle = theme.bubbleFill;
    ctx.fill();

    if (lod) {
      return;
    }

    ctx.fillStyle = theme.bubbleText;
    ctx.font = this.metrics.font('label');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    bubble.lines.forEach((line, i) => {
      ctx.fillText(
        line,
        r.x + BUBBLE_PADDING_X,
        r.y + BUBBLE_PADDING_Y + BUBBLE_LINE_HEIGHT * (i + 0.5)
      );
    });
  }
}
