;; Java Structure Queries

(method_declaration) @fn
(constructor_declaration) @fn
(class_declaration) @class
(interface_declaration) @interface
(enum_declaration) @class
(method_invocation) @call
(object_creation_expression) @call
(import_declaration) @import

;; ── Variables ──
(field_declaration) @var
(local_variable_declaration) @var

;; ── Writes ──
(assignment_expression) @write

;; ── Throws ──
(throw_statement) @throws

;; ── Usage ──
(identifier) @usage
