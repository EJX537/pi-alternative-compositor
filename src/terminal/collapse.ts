/**
 * @deprecated Import from `../collapse/types.js` and `../collapse/collapse-controller.js` directly.
 *
 * This file is kept as a thin re-export shim so existing imports resolve.
 * New code should import from the dedicated collapse modules.
 */

export {
    isAssistantComponent,
    isToolComponent,
    isThinkingMarkdown as isThinkingMarker,
    findThinkingChild,
    isCollapsibleComponent,
} from "../collapse/types.js";

export type {
    AssistantComponent,
    ToolComponent,
} from "../collapse/types.js";

export { CollapseController } from "../collapse/collapse-controller.js";
