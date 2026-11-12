<script setup lang="ts">
/**
 * Opens and closes collapsible content (one element with `v-if` in the slot)
 * by animating its height, unless the user asked for less motion.
 */
const DURATION_MS = 150;

function animateHeight(
  el: Element,
  from: number,
  to: number,
  done: () => void
): void {
  const element = el as HTMLElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || from === to) {
    done();
    return;
  }

  element.style.overflow = 'hidden';
  const animation = element.animate(
    [
      { height: `${from}px`, opacity: from === 0 ? 0 : 1 },
      { height: `${to}px`, opacity: to === 0 ? 0 : 1 },
    ],
    { duration: DURATION_MS, easing: 'ease-out' }
  );
  const finish = (): void => {
    element.style.overflow = '';
    done();
  };
  animation.addEventListener('finish', finish);
  animation.addEventListener('cancel', finish);
}

function onEnter(el: Element, done: () => void): void {
  animateHeight(el, 0, (el as HTMLElement).scrollHeight, done);
}

function onLeave(el: Element, done: () => void): void {
  animateHeight(el, (el as HTMLElement).offsetHeight, 0, done);
}
</script>

<template>
  <Transition :css="false" @enter="onEnter" @leave="onLeave">
    <slot />
  </Transition>
</template>
