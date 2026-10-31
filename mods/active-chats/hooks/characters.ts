export type Pose = 'waiting' | 'working' | 'idle' | 'asleep' | 'archived' | 'allClear'

const RED = '#e5534b'
const GREEN = '#3fb950'
const GREY = '#b4b4b4'
const INK = '#24292f'

function hash(id: string): number {
  let value = 0
  for (const char of id) value = (value * 31 + char.charCodeAt(0)) >>> 0

  return value
}

const repeat = (dur: string) => `dur="${dur}" repeatCount="indefinite"`

function hop(height: number, dur: string): string {
  return `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${height};0 0" ${repeat(dur)}/>`
}

function swing(from: number, to: number, x: number, y: number, dur: string): string {
  return `<animateTransform attributeName="transform" type="rotate" values="${from} ${x} ${y};${to} ${x} ${y};${from} ${x} ${y}" ${repeat(dur)}/>`
}

function body(color: string, variant: number): string {
  const topper = [
    '',
    `<path d="M24 14V7" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/><circle cx="24" cy="6" r="2.5" fill="${color}"/>`,
    `<path d="M14 18l-2-8 8 4zM34 18l2-8-8 4z" fill="${color}"/>`,
    `<path d="M20 14q4-8 8 0" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`,
  ][variant]

  return `${topper}<path d="M10 28c0-9 6-15 14-15s14 6 14 15c0 8-5 12-14 12s-14-4-14-12z" fill="${color}"/>`
}

const openEyes = `<circle cx="19" cy="25" r="2.6" fill="${INK}"/><circle cx="29" cy="25" r="2.6" fill="${INK}"/>`
const closedEyes = `<path d="M16 25q3 2.5 6 0M26 25q3 2.5 6 0" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`
const smile = `<path d="M21 31q3 2.5 6 0" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>`

function arm(side: 'left' | 'right', color: string, motion: string): string {
  const [x1, x2] = side === 'left' ? [12, 5] : [36, 43]

  return `<g><path d="M${x1} 27L${x2} 18" stroke="${color}" stroke-width="3.5" stroke-linecap="round"/>${motion}</g>`
}

function art(pose: Pose, color: string, variant: number, isMoving: boolean): string {
  const anim = (motion: string) => (isMoving ? motion : '')

  switch (pose) {
    case 'waiting': {
      const mark = `<g><text x="42" y="11" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="800" fill="${RED}">!</text>${anim(`<animate attributeName="opacity" values="1;0.25;1" ${repeat('0.7s')}/>`)}</g>`
      const left = arm('left', color, anim(swing(-20, 20, 12, 27, '0.35s')))
      const right = arm('right', color, anim(swing(20, -20, 36, 27, '0.35s')))

      return `<g>${left}${right}${body(color, variant)}${openEyes}<ellipse cx="24" cy="32" rx="3" ry="3.5" fill="${INK}"/>${anim(hop(4, '0.7s'))}</g>${mark}`
    }
    case 'working': {
      const hands = `<g><path d="M17 37h4M27 37h4" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>${anim(hop(1.5, '0.25s'))}</g>`

      return `<g>${body(color, variant)}${openEyes}${smile}${anim(hop(1, '0.5s'))}</g><rect x="13" y="35" width="22" height="9" rx="1.5" fill="${GREEN}"/><rect x="10" y="43" width="28" height="2.5" rx="1.2" fill="${INK}"/>${hands}`
    }
    case 'asleep':
      return `${body(color, variant)}${closedEyes}<path d="M22 32h4" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/><text x="37" y="13" font-family="sans-serif" font-size="9" font-weight="700" fill="${GREY}">z</text><text x="42" y="7" font-family="sans-serif" font-size="6" font-weight="700" fill="${GREY}">z</text>`
    case 'archived':
      return `${body(color, variant)}${openEyes}<rect x="6" y="28" width="36" height="17" rx="2" fill="#a98a63"/><rect x="4" y="26" width="40" height="5" rx="1.5" fill="#8a6d49"/><rect x="20" y="33" width="8" height="3" rx="1" fill="#6d5436"/>`
    case 'allClear': {
      const drink = `<path d="M38 22h7l-3 8h-1z" fill="#ffd33d" stroke="${INK}" stroke-width="0.8"/><path d="M41.5 30v6M39 36h5M43 22l2-5" stroke="${INK}" stroke-width="1" stroke-linecap="round"/>`
      const shades = `<rect x="14" y="22" width="8.5" height="5.5" rx="2" fill="${INK}"/><rect x="25.5" y="22" width="8.5" height="5.5" rx="2" fill="${INK}"/><path d="M22 24h4" stroke="${INK}" stroke-width="1.5"/>`

      return `<g>${body(color, variant)}${shades}${smile}${drink}${anim(hop(2, '2.4s'))}</g>`
    }
    default:
      return `${body(color, variant)}${openEyes}${smile}`
  }
}

export function isAnimated(pose: Pose): boolean {
  return pose === 'waiting' || pose === 'working' || pose === 'allClear'
}

/** The same chat always gets the same creature; its pose follows its status. */
export function characterSvg(id: string, pose: Pose): string {
  const value = hash(id)
  const isFaded = pose === 'asleep' || pose === 'archived'
  const color = isFaded ? '#c9ccd1' : `hsl(${value % 360} 72% 62%)`
  const variant = (value >>> 9) % 4
  const open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">'
  if (!isAnimated(pose)) return `${open}${art(pose, color, variant, false)}</svg>`

  // The still copy only shows under Reduce Motion, and stays hidden if a surface strips the style.
  return `${open}<style>@media (prefers-reduced-motion: reduce){.moving{display:none}.still{display:inline}}</style><g class="moving">${art(pose, color, variant, true)}</g><g class="still" display="none">${art(pose, color, variant, false)}</g></svg>`
}
