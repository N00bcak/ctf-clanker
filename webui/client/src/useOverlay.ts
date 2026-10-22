import { useEffect, useRef, useState, type RefObject } from "react";

export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
    useEffect(() => {
        const media = window.matchMedia?.(query);
        if (!media) return;
        const update = () => setMatches(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, [query]);
    return matches;
}

export function useOverlay(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void): void {
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        if (!open || !ref.current) return;
        const overlay = ref.current;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const focusable = () => Array.from(overlay.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']"
        )).sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        (focusable()[0] ?? overlay).focus();
        const onKeyDown = (event: KeyboardEvent) => {
            const layer = (element: Element) => {
                let value = 0;
                for (let parent: Element | null = element; parent; parent = parent.parentElement) {
                    value = Math.max(value, Number.parseInt(window.getComputedStyle(parent).zIndex, 10) || 0);
                }
                return value;
            };
            const top = Array.from(document.querySelectorAll('[aria-modal="true"]'))
                .reduce<Element | undefined>((current, modal) => !current || layer(modal) >= layer(current) ? modal : current, undefined);
            if (event.defaultPrevented || top !== overlay) return;
            if (event.key === "Escape") {
                event.preventDefault();
                closeRef.current();
            } else if (event.key === "Tab") {
                const items = focusable();
                const first = items[0] ?? overlay;
                const last = items[items.length - 1] ?? overlay;
                if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            if (previous?.isConnected) previous.focus();
        };
    }, [open, ref]);
}
