CLASS zcl_with_calls DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS do_work.
ENDCLASS.

CLASS zcl_with_calls IMPLEMENTATION.
  METHOD do_work.
    DATA lv_result TYPE string.

    CALL FUNCTION 'Z_MY_CUSTOM_FM'
      EXPORTING
        iv_input = 'test'
      IMPORTING
        ev_output = lv_result.

    CALL FUNCTION 'BAPI_MATERIAL_GETLIST'
      EXPORTING
        matnrselection = 'X'.

    SUBMIT z_my_report AND RETURN.
  ENDMETHOD.
ENDCLASS.
