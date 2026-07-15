;; Elixir Structure Queries
;;
;; NOTE: tree-sitter-elixir 0.3 parses `def`, `defp`, `defmodule`, `raise` as
;; generic (call) nodes — they are captured by @call below, not as named @fn/@class.
;; `alias` is the only module-level import with its own node kind.

(anonymous_function) @fn
(call) @call
(dot) @call
(binary_operator) @call

;; ── Imports ──
(alias) @import

;; ── Variables ──
(binary_operator) @var

;; ── Usage ──
(identifier) @usage
