;; Elixir dataflow queries
;; tree-sitter-elixir 0.3 — minimal: reads + scope + sequences.

;; All identifiers — engine filters to reads
(identifier) @read
;; Call targets
(alias) @read

;; Sequences
(call) @sequence
