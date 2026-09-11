import type { ProjectAuthorizationService, ActorContext } from '../authz/project-authz.js';
import { DesignSystemRegistry } from './design-system.js';

export interface ProjectsView {
  projectId: string;
  role: ReturnType<ProjectAuthorizationService['getRole']>;
}

/** @id CODE-AIRA2-GUI-006
 * @implements REQ-GUI-005
 * @design DES-AIRA2-010
 * Minimal view-model for the existing projects area, retained here only
 * so it can be registered against the shared design-system tokens for the
 * REQ-GUI-005 uniform-styling check; the project sharing/authorization UI
 * itself is unchanged by this feature.
 */
export class ProjectsUiController {
  constructor(
    private readonly authz: ProjectAuthorizationService,
    registry: DesignSystemRegistry = new DesignSystemRegistry(),
  ) {
    registry.register('projects');
  }

  view(actor: ActorContext, projectId: string): ProjectsView {
    return { projectId, role: this.authz.getRole(projectId, actor.accountId) };
  }
}
