/** @id CODE-AIRA2-GUI-001
 * @implements REQ-GUI-005
 * @design DES-AIRA2-010
 * Shared design-system contract: every UI area view-model in this module
 * must declare which design-token set and component-library name it
 * renders with, so a design review (or an automated check, per
 * REQ-GUI-005) can confirm no UI area is left on an unstyled/legacy
 * component set.
 */
export const DESIGN_TOKENS = Object.freeze({
  name: 'aira2-design-tokens-v1',
  colorScheme: 'aira2-light-dark',
  componentLibrary: 'aira2-ui-kit',
});

export type UiAreaName = 'chat' | 'projects' | 'settings' | 'eln' | 'graphrag';

export interface DesignTokenSet {
  name: string;
  colorScheme: string;
  componentLibrary: string;
}

export interface UiAreaStyle {
  area: UiAreaName;
  designTokens: DesignTokenSet;
}

/** Areas that must be registered as using the shared design-system tokens. */
export const REQUIRED_UI_AREAS: readonly UiAreaName[] = ['chat', 'projects', 'settings', 'eln', 'graphrag'];

export class UnstyledUiAreaError extends Error {
  constructor(area: string) {
    super(`UI area does not use the shared design-system tokens: ${area}`);
  }
}

/**
 * Registry of every UI area's declared style. Areas register themselves
 * (see auth-ui.ts, llm-settings-ui.ts, eln-ui.ts, graphrag-ui.ts) so this
 * registry can be inspected to confirm full design-system coverage.
 */
export class DesignSystemRegistry {
  private readonly styles = new Map<UiAreaName, UiAreaStyle>();

  register(area: UiAreaName, designTokens: DesignTokenSet = DESIGN_TOKENS): void {
    if (designTokens !== DESIGN_TOKENS) {
      throw new UnstyledUiAreaError(area);
    }
    this.styles.set(area, { area, designTokens });
  }

  isFullyStyled(): boolean {
    return REQUIRED_UI_AREAS.every((area) => this.styles.has(area));
  }

  unstyledAreas(): UiAreaName[] {
    return REQUIRED_UI_AREAS.filter((area) => !this.styles.has(area));
  }

  styleFor(area: UiAreaName): UiAreaStyle | undefined {
    return this.styles.get(area);
  }
}
