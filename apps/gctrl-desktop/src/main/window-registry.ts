// Tracks open BrowserWindows in most-recently-focused order. Pure over a
// generic handle type so it can be unit-tested without pulling in `electron`.
//
// Why not `BrowserWindow.getFocusedWindow()`: it returns null whenever the
// app is in the background — exactly the deep-link case (`gctrl://...`
// clicked in a browser), where main must still pick a window to navigate.

export interface WindowRegistry<W> {
  /** Register a new window as the most recently focused. */
  readonly add: (win: W) => void
  /** Move a window to the front of the focus order. */
  readonly noteFocused: (win: W) => void
  /** Drop a window (closed). No-op if unknown. */
  readonly remove: (win: W) => void
  /** The window deep links and IPC broadcasts should target. */
  readonly mostRecentlyFocused: () => W | undefined
  readonly isEmpty: () => boolean
}

export const createWindowRegistry = <W>(): WindowRegistry<W> => {
  // Last element = most recently focused.
  const order: W[] = []

  const remove = (win: W): void => {
    const i = order.indexOf(win)
    if (i !== -1) order.splice(i, 1)
  }

  const promote = (win: W): void => {
    remove(win)
    order.push(win)
  }

  return {
    add: promote,
    noteFocused: promote,
    remove,
    mostRecentlyFocused: () => order[order.length - 1],
    isEmpty: () => order.length === 0,
  }
}
