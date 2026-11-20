/** Arrow keys move between a toolbar's buttons (the ARIA toolbar pattern); Tab still reaches each of them. Both editors use it. */
export function moveInToolbar(event: KeyboardEvent): void {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
    return;
  }
  // A button hidden at this width (the designer's Adicionar componente) can't take the focus, so it is skipped.
  const buttons = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not([disabled])')).filter(
    (button) => getComputedStyle(button).display !== 'none',
  );
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
  next?.focus();
  event.preventDefault();
}
