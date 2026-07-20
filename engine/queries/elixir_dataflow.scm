;; Elixir dataflow queries
;; tree-sitter-elixir 0.3

;; Writes — pattern match x = ...
;; ponytail: matches ALL binary_operator left-side identifiers (not just "=").
;; False positives on comparisons (==, <, etc.) are harmless — the engine
;; deduplicates per (scope, variable) pair. Add operator predicate when
;; tree-sitter 0.25 anonymous-node field matching is verified stable.
(binary_operator left: (identifier) @write)

;; All identifiers — engine filters to reads
(identifier) @read
;; Call targets
(alias) @read

;; Scope boundaries — anonymous functions only; def/defp are macro calls
(anonymous_function) @scope_fn

;; Sequences
(call) @sequence
