/**
 * @fileoverview MiniappHeader — drop-in header component that aligns with
 * the host's floating capsule menu.
 *
 * The header has three slots: `left`, `title`, and `right`. Content auto-
 * respects the safe area and leaves room for the capsule menu on the far
 * top-right. Typical usage:
 *
 *   <MiniappHeader
 *     title="My Miniapp"
 *     left={<BackButton onClick={goBack} />}
 *     right={<Badge>Connected</Badge>}
 *   />
 *
 * If `title` is a string it renders as a semantic <h1>. Pass a ReactNode if
 * you need custom styling. The component itself is unstyled beyond the
 * layout — use `className` or `style` for theming.
 */
import type { CSSProperties, ReactNode } from "react";
import { type UseCapsuleHeaderStyleOptions } from "./useCapsuleHeaderStyle";
export interface MiniappHeaderProps extends UseCapsuleHeaderStyleOptions {
    /** Title — string renders as <h1>; pass a node for custom markup. */
    title?: ReactNode;
    /** Left slot, typically a back button or logo. Overrides onBack if both set. */
    left?: ReactNode;
    /**
     * Shortcut: when provided, renders a back chevron in the left slot that
     * calls this handler. Ignored if `left` is explicitly set.
     */
    onBack?: () => void;
    /** Right slot, typically a badge or action buttons. Sits to the left of the capsule. */
    right?: ReactNode;
    /** Custom className applied to the header element. */
    className?: string;
    /** Inline style overrides merged over the computed layout style. */
    style?: CSSProperties;
    /**
     * When true, adds a 8px spacer <div> below the header so your next
     * content doesn't sit flush against it. Default true.
     */
    bottomSpacer?: boolean;
}
export declare function MiniappHeader({ title, left, onBack, right, className, style, bottomSpacer, ...styleOptions }: MiniappHeaderProps): ReactNode;
//# sourceMappingURL=MiniappHeader.d.ts.map