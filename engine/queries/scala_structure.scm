;; Scala Structure Queries

(function_definition) @fn
(method_definition) @fn
(class_definition) @class
(object_definition) @class
(trait_definition) @interface
(call_expression) @call
(generic_function) @call
(field_expression) @call
(infix_expression) @call
(instance_expression) @call
(import_declaration) @import

;; ── Variables ──
(val_definition) @var
(var_definition) @var
(val_declaration) @var
(var_declaration) @var

;; ── Writes ──
(assignment_expression) @write

;; ── Throws ──
(throw_expression) @throws

;; ── Usage ──
(identifier) @usage
