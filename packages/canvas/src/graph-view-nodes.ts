import {
  compactTitle,
  headerIcon,
  ICON_SPACE,
  isArrayType,
  isCompact,
  isLatent,
  isOperatorGlyph,
  NODE_METRICS,
  pinColor,
  pinKey,
  pinLabel,
} from '@vizscript/core';
import type { HeaderIcon, Pin, PinGeometry, Point } from '@vizscript/core';
import {
  BUBBLE_GAP,
  BUBBLE_LINE_HEIGHT,
  BUBBLE_PADDING_X,
  BUBBLE_PADDING_Y,
} from './bubble';
import { easeOut } from './camera';
import type { Rect } from './camera';
import { GraphViewCamera } from './graph-view-camera';
import {
  ADVANCED_ROW,
  BANNER_GAP,
  BANNER_HEIGHT,
  isChecked,
  NODE_APPEAR_MS,
  NODE_PULSE_MS,
} from './graph-view-constants';
import type { NodeState } from './graph-view-types';

/** Drawing of nodes: body, header, pins, values, bubbles, banners. */
export abstract class GraphViewNodes extends GraphViewCamera {
  /** A node, faded and grown in while it appears, then its pulse. */
  protected drawNodeAnimated(ns: NodeState): void {
    const { ctx } = this;
    if (ns.appear === undefined) {
      this.drawNode(ns);
    } else {
      const k = easeOut((this.frameTime - ns.appear) / NODE_APPEAR_MS);
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
      const k = easeOut((this.frameTime - ns.pulse) / NODE_PULSE_MS);
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
      ctx.lineWidth = 2.5 / Math.max(this.camera.zoom, 0.4);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawNode(ns: NodeState): void {
    const { ctx, theme } = this;
    const { node, geom } = ns;
    const lod = this.camera.zoom < 0.4;
    const compact = isCompact(node);
    const r = compact
      ? Math.min(geom.height / 2, 14)
      : NODE_METRICS.cornerRadius;
    const id = node.id;

    this.drawBubble(ns, lod);
    this.drawProblemBanner(ns, lod);

    // Body, with a soft drop shadow like UE's (not at overview zoom).
    ctx.save();
    if (!lod) {
      const scale = this.camera.zoom * this.dpr;
      ctx.shadowColor = theme.nodeShadow;
      ctx.shadowBlur = 14 * scale;
      ctx.shadowOffsetY = 3 * scale;
    }

    ctx.beginPath();
    ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
    if (compact) {
      ctx.fillStyle =
        node.category === 'variable'
          ? theme.compactVariable
          : node.purity === 'pure'
            ? theme.compactPure
            : theme.nodeBody;
    } else {
      ctx.fillStyle = theme.nodeBody;
    }

    ctx.fill();
    ctx.restore();

    // Like UE's Get pills: a tint of the value's type from the left.
    if (compact && node.category === 'variable' && node.kind !== 'setVar') {
      const out = node.pins.find(
        (p) => p.direction === 'out' && p.kind === 'data'
      );
      if (out) {
        const color = pinColor(out.type, theme.scheme);
        const tint = ctx.createLinearGradient(
          ns.x,
          ns.y,
          ns.x + geom.width,
          ns.y
        );
        tint.addColorStop(0, `${color}${theme.pillTint}`);
        tint.addColorStop(1, `${color}00`);
        ctx.beginPath();
        ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
        ctx.fillStyle = tint;
        ctx.fill();
      }
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
    } else if (node.category !== 'variable') {
      ctx.beginPath();
      ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
      ctx.strokeStyle = `${theme.categories[node.category]}cc`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Outline
    const selected = this.selection.has(id);
    const highlighted = this.highlight.has(id);
    const hovered = this.hoverNode === id;
    ctx.beginPath();
    ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
    if (selected || highlighted || hovered) {
      ctx.strokeStyle = selected
        ? theme.selection
        : highlighted
          ? theme.codeHighlight
          : theme.hover;
      ctx.lineWidth = selected || highlighted ? 2.5 : 1.5;
    } else {
      ctx.strokeStyle = theme.nodeBorder;
      ctx.lineWidth = 1.5;
    }

    ctx.stroke();

    // Title
    ctx.textBaseline = 'middle';
    if (compact) {
      ctx.font = this.font('compact');
      ctx.fillStyle = theme.nodeText;
      ctx.textAlign = 'center';
      const left =
        geom.leftColumn > 0 ? geom.leftColumn + 4 : NODE_METRICS.paddingX;
      const right =
        geom.rightColumn > 0 ? geom.rightColumn + 4 : NODE_METRICS.paddingX;
      const centerX = ns.x + (left + geom.width - right) / 2;
      // A setter shows `SET` and, small below, how it declares (`const`).
      const sub = node.subtitle && !lod ? node.subtitle : '';
      const centerY = ns.y + geom.height / 2 - (sub ? 6 : 0);
      if (isOperatorGlyph(node)) {
        ctx.font = this.font('glyph');
        ctx.fillStyle = theme.operatorGlyph;
      }

      ctx.fillText(compactTitle(node), centerX, centerY);
      if (sub) {
        ctx.font = this.font('subtitle');
        ctx.fillStyle = theme.compactSubtext;
        ctx.fillText(sub, centerX, centerY + 14);
      }
    } else {
      const icon = lod ? undefined : headerIcon(node);
      const titleY = ns.y + NODE_METRICS.headerHeight / 2 + 1;
      if (icon) {
        this.drawHeaderIcon(
          icon,
          ns.x + NODE_METRICS.paddingX + 6,
          titleY,
          theme.nodeTitle
        );
      }

      if (isLatent(node) && !lod) {
        this.drawClock(
          ns.x + geom.width - NODE_METRICS.paddingX - 6,
          titleY,
          theme.nodeTitle
        );
      }

      ctx.font = this.font('title');
      ctx.fillStyle = theme.nodeTitle;
      ctx.textAlign = 'left';
      ctx.save();
      if (!lod) {
        const scale = this.camera.zoom * this.dpr;
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
        ctx.font = this.font('subtitle');
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
  }

  /** UE's ▼ under a node with folded advanced pins (▲ when shown). */
  private drawAdvancedToggle(ns: NodeState): void {
    const { ctx, theme } = this;
    const x = ns.x + ns.geom.width / 2;
    const y = ns.y + ns.geom.height - ADVANCED_ROW / 2 - 1;
    const open = this.expandedNodes.has(ns.full.id);
    const hovered = this.hoverNode === ns.node.id;
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

  /**
   * Header icons like UE's: ƒ for functions, a diamond for events, a fork
   * for branches, a circular arrow for loops (12 px, centered on `x`, `y`).
   */
  private drawHeaderIcon(
    icon: HeaderIcon,
    x: number,
    y: number,
    color: string
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (icon) {
      case 'function':
      case 'unknown': {
        ctx.font = `italic 600 15px Georgia, "Times New Roman", serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icon === 'function' ? 'ƒ' : '?', x, y + 1);
        break;
      }

      case 'event': {
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 6);
        ctx.lineTo(x - 6, y);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'branch': {
        ctx.beginPath();
        ctx.moveTo(x - 6, y);
        ctx.lineTo(x - 1, y);
        ctx.moveTo(x - 1, y);
        ctx.lineTo(x + 5, y - 5);
        ctx.moveTo(x - 1, y);
        ctx.lineTo(x + 5, y + 5);
        ctx.stroke();
        break;
      }

      case 'loop': {
        ctx.beginPath();
        ctx.arc(x, y, 5, Math.PI * 0.15, Math.PI * 1.75);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 5.5, y - 5);
        ctx.lineTo(x + 5, y - 1);
        ctx.lineTo(x + 1.5, y - 2.5);
        ctx.stroke();
        break;
      }
    }

    ctx.restore();
  }

  /** UE's clock on latent nodes (`await`). */
  private drawClock(x: number, y: number, color: string): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 3.5);
    ctx.moveTo(x, y);
    ctx.lineTo(x + 2.5, y + 1.5);
    ctx.stroke();
    ctx.restore();
  }

  private drawPin(ns: NodeState, pg: PinGeometry, lod: boolean): void {
    const { ctx, theme } = this;
    const pin: Pin = pg.pin;
    const p = this.pinWorld(ns, pg);
    const connected = this.connectedPins.has(
      pinKey({ node: ns.node.id, pin: pin.id })
    );
    const hovered = this.hoverNode === ns.node.id && this.hoverPin === pin.id;
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
      if (isArrayType(pin.type)) {
        this.drawArrayPin(p, r, color, connected);
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
      ctx.font = this.font('label');
      ctx.fillStyle = theme.pinLabel;
      ctx.textAlign = pg.side === 'left' ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, labelX, p.y);
    }

    const lr = this.literalRect(ns, pg);
    if (lr && pin.literal?.kind === 'boolean') {
      this.drawCheckbox(lr, isChecked(pin.literal.value));
    } else if (lr && pin.literal) {
      ctx.beginPath();
      ctx.roundRect(lr.x, lr.y, lr.width, lr.height, 4);
      ctx.fillStyle = theme.literalBackground;
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.rect(lr.x + 4, lr.y, lr.width - 8, lr.height);
      ctx.clip();
      ctx.font = this.font('literal');
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

  /** UE's checkbox for boolean values. */
  private drawCheckbox(rect: Rect, checked: boolean): void {
    const { ctx, theme } = this;
    const size = NODE_METRICS.checkboxSize;
    const x = rect.x;
    const y = rect.y + (rect.height - size) / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, 3);
    ctx.fillStyle = theme.literalBackground;
    ctx.fill();
    ctx.strokeStyle = theme.pinLabel;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (checked) {
      ctx.beginPath();
      ctx.moveTo(x + 3, y + size / 2);
      ctx.lineTo(x + size / 2 - 1, y + size - 4);
      ctx.lineTo(x + size - 3, y + 3.5);
      ctx.strokeStyle = theme.literalText;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  /**
   * Blueprint array pin: a 3×3 grid of squares in the element color,
   * filled when connected and outlined when not.
   */
  private drawArrayPin(
    center: Point,
    radius: number,
    color: string,
    connected: boolean
  ): void {
    const { ctx } = this;
    const size = radius * 2 + 2;
    const gap = size * 0.12;
    const cell = (size - gap * 2) / 3;
    const left = center.x - size / 2;
    const top = center.y - size / 2;
    ctx.beginPath();
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        ctx.rect(
          left + col * (cell + gap),
          top + row * (cell + gap),
          cell,
          cell
        );
      }
    }

    if (connected) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawProblemBanner(ns: NodeState, lod: boolean): void {
    const severity = this.problems.get(ns.node.id);
    if (!severity) {
      return;
    }

    const { ctx, theme } = this;
    const y = ns.y + ns.geom.height + BANNER_GAP;
    const color =
      severity === 'error'
        ? theme.errorBanner
        : severity === 'warning'
          ? theme.warningBanner
          : theme.infoBanner;
    ctx.beginPath();
    ctx.roundRect(ns.x, y, ns.geom.width, BANNER_HEIGHT, 4);
    ctx.fillStyle = color;
    ctx.fill();
    if (lod) {
      return;
    }

    ctx.fillStyle = theme.bannerText;
    ctx.font = `700 10px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(
      severity === 'error'
        ? 'ERROR!'
        : severity === 'warning'
          ? 'WARNING!'
          : 'NOTE',
      ns.x + 8,
      y + BANNER_HEIGHT / 2 + 0.5
    );
  }

  private drawBubble(ns: NodeState, lod: boolean): void {
    const r = this.bubbleRect(ns);
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
    ctx.font = this.font('label');
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
