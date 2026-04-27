; ─────────────────────────────────────────────────────────────
; installer.nsi — Script NSIS para o app Agendamentos
;
; Como usar:
;   1. Rode "npm run build" para gerar a pasta dist\win-unpacked
;   2. Rode: & "C:\Program Files (x86)\NSIS\makensis.exe" installer.nsi
;
; O Setup.exe gerado fica em dist\Agendamentos-Setup-x.x.x.exe
; ─────────────────────────────────────────────────────────────

Unicode True

; ── Informações do app ───────────────────────────────────────
!define APP_NAME        "Agendamentos"
!define APP_VERSION     "1.0.5"
!define APP_PUBLISHER   "Agendamentos"
!define APP_EXE         "Agendamentos.exe"
!define APP_ICON        "assets\icon.ico"
!define SOURCE_DIR      "dist\win-unpacked"
!define OUTPUT_DIR      "dist"
!define INSTALL_DIR     "$PROGRAMFILES64\${APP_NAME}"
!define UNINST_KEY      "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

; ── Configurações gerais ─────────────────────────────────────
Name                    "${APP_NAME}"
OutFile                 "${OUTPUT_DIR}\Agendamentos-Setup-${APP_VERSION}.exe"
InstallDir              "${INSTALL_DIR}"
InstallDirRegKey        HKLM "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel   admin
SetCompressor           lzma
SetCompressorDictSize   32

; ── Páginas do instalador ────────────────────────────────────
!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON                        "${APP_ICON}"
!define MUI_UNICON                      "${APP_ICON}"
!define MUI_WELCOMEPAGE_TITLE           "Bem-vindo ao instalador do ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT            "Este assistente vai instalar o ${APP_NAME} no seu computador.$\r$\n$\r$\nClique em Avançar para continuar."
!define MUI_FINISHPAGE_RUN              "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT         "Abrir ${APP_NAME} agora"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "PortugueseBR"

; ── Instalação ───────────────────────────────────────────────
Section "Principal" SecMain

  SetOutPath "$INSTDIR"

  ; Copia todos os arquivos da win-unpacked para a pasta de instalação
  File /r "${SOURCE_DIR}\*.*"

  ; Cria atalho na Área de Trabalho
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" \
    "$INSTDIR\${APP_EXE}" "" \
    "$INSTDIR\${APP_EXE}" 0

  ; Cria atalho no Menu Iniciar
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" \
    "$INSTDIR\${APP_EXE}" "" \
    "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Desinstalar ${APP_NAME}.lnk" \
    "$INSTDIR\Uninstall.exe"

  ; Grava o desinstalador
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Registra no "Adicionar ou remover programas"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayName"          "${APP_NAME}"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayVersion"        "${APP_VERSION}"
  WriteRegStr   HKLM "${UNINST_KEY}" "Publisher"             "${APP_PUBLISHER}"
  WriteRegStr   HKLM "${UNINST_KEY}" "InstallLocation"       "$INSTDIR"
  WriteRegStr   HKLM "${UNINST_KEY}" "UninstallString"       "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayIcon"           "$INSTDIR\${APP_EXE}"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify"              1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair"              1

SectionEnd

; ── Desinstalação ─────────────────────────────────────────────
Section "Uninstall"

  ; Remove atalhos
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Desinstalar ${APP_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"

  ; Remove arquivos do app
  RMDir /r "$INSTDIR"

  ; Remove registro do Windows
  DeleteRegKey HKLM "${UNINST_KEY}"

SectionEnd
