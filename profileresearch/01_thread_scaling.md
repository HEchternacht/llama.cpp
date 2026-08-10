ggml_cuda_init: found 1 CUDA devices (Total VRAM: 6140 MiB):
  Device 0: NVIDIA GeForce RTX 4050 Laptop GPU, compute capability 8.9, VMM: yes, VRAM: 6140 MiB
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 6140 MiB):
  Device 0: NVIDIA GeForce RTX 4050 Laptop GPU, compute capability 8.9, VMM: yes, VRAM: 6140 MiB
load_backend: loaded CUDA backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-cuda.dll
load_backend: loaded RPC backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-rpc.dll
load_backend: loaded CPU backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-cpu-alderlake.dll
| model                          |       size |     params | backend    | ngl |  n_cpu_moe | threads | n_ubatch | type_k | type_v |  fa | mmap |            test |                  t/s |
| ------------------------------ | ---------: | ---------: | ---------- | --: | ---------: | ------: | -------: | -----: | -----: | --: | ---: | --------------: | -------------------: |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |       2 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         25.64 ± 1.45 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |       4 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         35.54 ± 0.04 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         38.58 ± 0.07 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |       8 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         38.25 ± 0.06 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |      10 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         36.46 ± 0.15 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |      12 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         37.45 ± 0.05 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |      16 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         37.37 ± 0.10 |

build: fd1a05791 (9852)
