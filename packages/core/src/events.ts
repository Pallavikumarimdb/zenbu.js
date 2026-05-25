export type Events = {
  shortcuts: {
    /**
     * Broadcast whenever the set of registered shortcut definitions or
     * user-configured bindings changes. The renderer subscribes to push
     * the current binding list down into every iframe so the prelude
     * can `preventDefault()` matching keystrokes synchronously.
     */
    changed: {};
  };
};
