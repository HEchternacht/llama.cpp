@echo off
set GGML_CUDA_REGISTER_HOST=1
python "%~dp0llama_launcher.py"
pause
