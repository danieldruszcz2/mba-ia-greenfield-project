# Fase 03 — Restrições de escopo para o `/research`

> Documento externo para `/research phase 03`. As capabilities da Fase 03 em `docs/project-plan.md` continuam sendo o limite do escopo. Este documento só restringe esse escopo.

## Escopo: apenas backend

O desafio desta fase entrega **somente o backend**. A interface de vídeo não faz parte do escopo desta fase.

| Subprojeto | Situação na Fase 03 |
|------------|---------------------|
| `nestjs-project/` | **Em escopo.** |
| `next-frontend/` | **Fora do escopo.** Nenhum código nem teste nesta fase. |

## Restrições para as decisões técnicas (TDs)

1. **Nenhuma TD com `Scope: Frontend`.**
2. **TDs `Cross-layer` descrevem só o lado da API**, ou seja, o contrato que o frontend vai consumir numa fase futura. Não decidem a implementação no frontend.
3. Na nota `_Subprojects in scope:_` do documento de decisões, `next-frontend/` aparece com a justificativa "fora do escopo do desafio (backend-only), sem TD nesta fase".
