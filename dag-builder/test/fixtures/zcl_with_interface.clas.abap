CLASS zcl_with_interface DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_processor.
    METHODS run.
  PRIVATE SECTION.
    DATA mo_dep TYPE REF TO zcl_dependency.
ENDCLASS.

CLASS zcl_with_interface IMPLEMENTATION.
  METHOD zif_processor~execute.
    mo_dep->do_work( ).
  ENDMETHOD.

  METHOD run.
    zcl_static_helper=>perform_action( ).
  ENDMETHOD.
ENDCLASS.
