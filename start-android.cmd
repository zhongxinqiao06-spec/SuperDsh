@echo off
setlocal
node "%~dp0scripts\start-android.mjs" %*
set "androidExitCode=%errorlevel%"
if not "%androidExitCode%"=="0" pause
exit /b %androidExitCode%
