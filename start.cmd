@echo off
REM Double-click this to run Learn Git Aero.
REM
REM The app is built from ES modules, which every browser blocks over file://
REM as a cross-origin request. Opening index.html directly therefore loads a
REM blank shell with dead controls. It needs to be served over http, which is
REM all this script does: start a static server in this folder and open it.

cd /d "%~dp0"

set PORT=8099

where py >nul 2>nul && (set PY=py) || (
  where python >nul 2>nul && (set PY=python) || (
    echo.
    echo   Python was not found, and it is what serves the files.
    echo.
    echo   Either install Python from https://www.python.org/downloads/
    echo   or, if you have Node installed, run this instead:
    echo.
    echo       npx --yes serve -l %PORT% .
    echo.
    echo   Then open http://localhost:%PORT%/
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   Serving this folder at http://localhost:%PORT%/
echo   Leave this window open while you use the app.
echo   Press Ctrl+C here when you are finished.
echo.

start "" "http://localhost:%PORT%/"
%PY% -m http.server %PORT%
