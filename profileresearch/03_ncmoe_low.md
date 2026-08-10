ggml_cuda_init: found 1 CUDA devices (Total VRAM: 6140 MiB):
  Device 0: NVIDIA GeForce RTX 4050 Laptop GPU, compute capability 8.9, VMM: yes, VRAM: 6140 MiB
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 6140 MiB):
  Device 0: NVIDIA GeForce RTX 4050 Laptop GPU, compute capability 8.9, VMM: yes, VRAM: 6140 MiB
load_backend: loaded CUDA backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-cuda.dll
load_backend: loaded RPC backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-rpc.dll
load_backend: loaded CPU backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-cpu-alderlake.dll
| model                          |       size |     params | backend    | ngl |  n_cpu_moe | threads | n_ubatch | type_k | type_v |  fa | mmap |            test |                  t/s |
| ------------------------------ | ---------: | ---------: | ---------- | --: | ---------: | ------: | -------: | -----: | -----: | --: | ---: | --------------: | -------------------: |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         28 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |        112.38 ± 0.55 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         28 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         22.70 ± 0.01 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         24 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |        115.10 ± 1.37 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         24 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         19.05 ± 0.03 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         20 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |        116.78 ± 0.09 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         20 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         15.76 ± 0.02 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         16 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |        477.24 ± 3.74 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         16 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         10.86 ± 0.11 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         12 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |        117.67 ± 2.25 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         12 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         11.98 ± 0.14 |

build: fd1a05791 (9852)
