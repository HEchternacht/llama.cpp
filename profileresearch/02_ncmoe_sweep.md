ggml_cuda_init: found 1 CUDA devices (Total VRAM: 6140 MiB):
  Device 0: NVIDIA GeForce RTX 4050 Laptop GPU, compute capability 8.9, VMM: yes, VRAM: 6140 MiB
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 6140 MiB):
  Device 0: NVIDIA GeForce RTX 4050 Laptop GPU, compute capability 8.9, VMM: yes, VRAM: 6140 MiB
load_backend: loaded CUDA backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-cuda.dll
load_backend: loaded RPC backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-rpc.dll
load_backend: loaded CPU backend from C:\Users\henri\OneDrive\Área de Trabalho\source_llama\llama.cpp\build\bin\Release\ggml-cpu-alderlake.dll
| model                          |       size |     params | backend    | ngl |  n_cpu_moe | threads | n_ubatch | type_k | type_v |  fa | mmap |            test |                  t/s |
| ------------------------------ | ---------: | ---------: | ---------- | --: | ---------: | ------: | -------: | -----: | -----: | --: | ---: | --------------: | -------------------: |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         48 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |       365.48 ± 24.57 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         48 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         36.50 ± 0.13 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         44 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |       350.30 ± 14.79 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         44 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         36.33 ± 0.77 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         40 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |        360.50 ± 5.68 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         40 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         36.39 ± 0.04 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         38 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |       358.72 ± 33.56 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         38 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         36.84 ± 0.04 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |       371.59 ± 30.43 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         36 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         37.31 ± 0.19 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         34 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |       382.52 ± 30.97 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         34 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         36.90 ± 0.36 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         32 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           pp512 |       510.71 ± 13.50 |
| qwen35moe 35B.A3B Q4_K - Medium |  15.39 GiB |    34.66 B | CUDA,CUDA  |  99 |         32 |       6 |     2048 |   q8_0 |   q8_0 |   1 |    0 |           tg128 |         36.03 ± 2.20 |

build: fd1a05791 (9852)
