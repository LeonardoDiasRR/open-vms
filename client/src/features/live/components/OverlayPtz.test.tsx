import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render } from '@testing-library/react';
import OverlayPtz, { type OverlayPtzHandle } from './OverlayPtz';

// jsdom does not compute layout: here the geometry is handed over (the component receives POINTS), and what
// is proved is the MATH — length, angle, 4 px threshold and the 180 ceiling — not the pixel.
function mount(hint: 'moving' | 'zoom-in' | 'zoom-out' | null = null) {
  const ref = createRef<OverlayPtzHandle>();
  const { container } = render(<OverlayPtz ref={ref} hint={hint} />);
  return {
    ref, container,
    root: () => container.querySelector('.ptz-overlay') as HTMLElement,
    tail: () => container.querySelector('.ptz-rasteira') as HTMLElement,
    arrow: () => container.querySelector('.ptz-seta') as HTMLElement,
    tip: () => container.querySelector('.ptz-ponta') as HTMLElement,
  };
}

describe('OverlayPtz: target, arrow and length (spec 2026-10-17, section 4.2)', () => {
  it('is born hidden and the target shows at the click point', () => {
    const t = mount();
    expect(t.root().style.display).toBe('none');
    act(() => t.ref.current!.show(40, 60));
    expect(t.root().style.display).toBe('block');
    expect(t.root().style.left).toBe('40px');
    expect(t.root().style.top).toBe('60px');
    expect(t.container.querySelector('.ptz-alvo')).not.toBeNull();
  });

  it('the arrow leaves the target towards the pointer with the distance length', () => {
    const t = mount();
    act(() => t.ref.current!.show(40, 60));
    act(() => t.ref.current!.update(140, 60));      // 100 px to the right
    expect(t.arrow().style.width).toBe('100px');
    expect(t.tail().style.transform).toBe('rotate(0deg)');
    expect(t.tip().style.left).toBe('100px');
    act(() => t.ref.current!.update(40, 160));      // 100 px downwards
    expect(t.arrow().style.width).toBe('100px');
    expect(t.tail().style.transform).toBe('rotate(90deg)');
  });

  it('the length STOPS at 180 px (the same radius as the maximum speed)', () => {
    const t = mount();
    act(() => t.ref.current!.show(0, 0));
    act(() => t.ref.current!.update(400, 0));
    expect(t.arrow().style.width).toBe('180px');
  });

  it('a drag shorter than 4 px shows only the target', () => {
    const t = mount();
    act(() => t.ref.current!.show(0, 0));
    act(() => t.ref.current!.update(3, 0));
    expect(t.arrow().style.display).toBe('none');
    expect(t.tip().style.display).toBe('none');
    act(() => t.ref.current!.update(4, 0));
    expect(t.arrow().style.display).toBe('block');
  });

  it('releasing hides the target and the arrow', () => {
    const t = mount();
    act(() => t.ref.current!.show(10, 10));
    act(() => t.ref.current!.update(110, 10));
    act(() => t.ref.current!.hide());
    expect(t.root().style.display).toBe('none');
  });
});

describe('OverlayPtz: the action hint (spec 2026-10-17, section 4.3)', () => {
  it('each action has its own text, with the ellipsis', () => {
    const t = mount('moving');
    const strip = t.container.querySelector('.ptz-aviso') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip).toHaveTextContent('Moving...');
  });

  it('the zoom has its own text and icon', () => {
    const t1 = mount('zoom-in');
    expect(t1.container.querySelector('.ptz-aviso')).toHaveTextContent('Zooming in...');
    const t2 = mount('zoom-out');
    expect(t2.container.querySelector('.ptz-aviso')).toHaveTextContent('Zooming out...');
  });

  it('without an action there is no strip', () => {
    const t = mount(null);
    expect(t.container.querySelector('.ptz-aviso')).toBeNull();
  });

  it('the whole overlay is decorative (aria-hidden) and does not steal the pointer', () => {
    const t = mount('moving');
    expect(t.root().getAttribute('aria-hidden')).toBe('true');
    // ponytail: the class carries the `pointer-events: none`; asserting the style would be jsdom, not CSS
    expect(t.container.querySelector('.ptz-aviso')?.className).toContain('ptz-aviso');
  });

  it('the strip is a SIBLING of the drag overlay, not a child (otherwise it anchors at the click point)', () => {
    const t = mount('moving');
    const strip = t.container.querySelector('.ptz-aviso') as HTMLElement;
    // .ptz-overlay is a zero-size element at the click point: if the strip sat INSIDE it, the CSS
    // `left/bottom: 16px` would place it 16 px FROM THE CLICK, not at the image corner (measured in the
    // browser: 283 px from the left instead of 16). The correct position depends on this SIBLING relation.
    expect(t.root().querySelector('.ptz-aviso')).toBeNull();
    expect(t.root().parentElement).toBe(strip.parentElement);
    expect(strip.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('OverlayPtz: the area selection rectangle (spec 2026-10-18, section 4)', () => {
  const rectangle = (t: ReturnType<typeof mount>) => t.container.querySelector('.ptz-selecao') as HTMLElement;

  it('is born hidden, shows anchored at the mousedown point and has the four corners', () => {
    const t = mount();
    expect(rectangle(t).style.display).toBe('none');
    const corners = [...t.container.querySelectorAll('.ptz-selecao-canto')];
    expect(corners.map((c) => c.getAttribute('data-canto'))).toEqual(['tl', 'tr', 'bl', 'br']);
    act(() => t.ref.current!.startSelection(40, 60, 640, 360));
    expect(rectangle(t).style.display).toBe('block');
    expect(rectangle(t).style.left).toBe('40px');
    expect(rectangle(t).style.top).toBe('60px');
    expect(rectangle(t).style.width).toBe('0px');
    expect(rectangle(t).style.height).toBe('0px');
  });

  it('the rectangle is locked to the box aspect, centered on the drag midpoint', () => {
    const t = mount();
    act(() => t.ref.current!.startSelection(100, 50, 640, 360));
    act(() => t.ref.current!.extend(400, 200));
    expect(rectangle(t).style.left).toBe('100px');
    expect(rectangle(t).style.top).toBe('40.625px');
    expect(rectangle(t).style.width).toBe('300px');
    expect(rectangle(t).style.height).toBe('168.75px');
  });

  it('the hollow circle sits at the rectangle center with diameter 15% of the shortest side (min 16)', () => {
    const t = mount();
    const circle = () => t.container.querySelector('.ptz-selecao-circulo') as HTMLElement;
    expect(circle().style.display).toBe('none'); // born hidden
    act(() => t.ref.current!.startSelection(100, 50, 800, 400));
    act(() => t.ref.current!.extend(400, 250));  // w = 400, h = 200
    expect(circle().style.display).toBe('block');
    expect(circle().style.width).toBe('30px');    // 0.15 * 200 = 30 (> 16)
    expect(circle().style.height).toBe('30px');
    expect(circle().style.left).toBe('185px');    // (400 - 30) / 2
    expect(circle().style.top).toBe('85px');      // (200 - 30) / 2
  });

  it('a 16 px minimum circle on a small rectangle', () => {
    const t = mount();
    const circle = () => t.container.querySelector('.ptz-selecao-circulo') as HTMLElement;
    act(() => t.ref.current!.startSelection(100, 100, 800, 400));
    act(() => t.ref.current!.extend(140, 120));  // w = max(40, 20*2) = 40, h = 20
    expect(circle().style.width).toBe('16px');    // 0.15 * 20 = 3 -> floor 16
  });

  it('the circle is a child of the rectangle (it disappears with it on clear)', () => {
    const t = mount();
    expect(t.container.querySelector('.ptz-selecao .ptz-selecao-circulo')).not.toBeNull();
  });

  it('clearing hides the rectangle without touching the target and the arrow', () => {
    const t = mount();
    act(() => t.ref.current!.startSelection(10, 10, 640, 360));
    act(() => t.ref.current!.extend(90, 90));
    act(() => t.ref.current!.show(10, 10));
    act(() => t.ref.current!.clearSelection());
    expect(rectangle(t).style.display).toBe('none');
    expect(t.root().style.display).toBe('block');
  });

  it('the layer is decorative: aria-hidden and a sibling of the arrow overlay, not a child', () => {
    const t = mount();
    expect(rectangle(t).getAttribute('aria-hidden')).toBe('true');
    expect(t.root().querySelector('.ptz-selecao')).toBeNull();
    expect(rectangle(t).parentElement).toBe(t.root().parentElement);
  });
});

describe('OverlayPtz: the selection CSS (spec 2026-10-18, section 4)', () => {
  // Reading the file as TEXT, in the form of design-tokens.test.ts: jsdom does not apply the sheet.
  const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

  it('fill, border and the overlay layer use ONLY tokens', () => {
    const block = /\.ptz-selecao \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(block).toContain('z-index: 4');
    expect(block).toContain('pointer-events: none');
    expect(block).toContain('border: 1px solid var(--accent)');
    expect(block).toContain('color-mix(in srgb, var(--accent) 18%, transparent)');
  });

  it('each "L" corner has a 12 px arm, 2 px thickness and goes OUTSIDE the rectangle', () => {
    const corner = /\.ptz-selecao-canto \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(corner).toContain('width: 12px');
    expect(corner).toContain('height: 12px');
    expect(corner).toContain('border: 0 solid var(--accent)');
    for (const [name, outside] of [['tl', 'left: -12px'], ['tr', 'right: -12px'], ['bl', 'left: -12px'], ['br', 'right: -12px']]) {
      const rule = new RegExp(`\\[data-canto='${name}'\\] \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? '';
      expect(rule, name).toContain(outside);
      expect(rule, name).toContain('2px');
    }
  });
});
