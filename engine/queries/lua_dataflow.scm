;; Lua dataflow queries
;; tree-sitter-lua 0.2 — minimal: reads + scope + sequences only.
;; Write patterns omitted (grammar node types unknown for this version).

;; All identifiers — engine filters to reads
(identifier) @read

;; Scope boundaries
(function_declaration) @scope_fn
(function_definition) @scope_fn

;; Sequences
(function_call) @sequence
