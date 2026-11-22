# Fotos dos concorrentes

Cada arquivo aqui vira a foto redonda na tabela de Concorrentes (aba
Monitoramento). O nome do arquivo é o @ do perfil, **sem o arroba**, em `.jpg`.

Se o arquivo não existir, a linha cai automaticamente nas iniciais coloridas —
não aparece imagem quebrada. Ou seja, dá para ir adicionando aos poucos.

## Arquivos esperados

| Perfil            | Arquivo                  |
| ----------------- | ------------------------ |
| Ricardo Lima      | `ricardolima.jpg`        |
| Clara Teles       | `clara.teles.jpg`        |
| Otávio Pires      | `oficialotaviopires.jpg` |
| Mário Vilela Neto | `dr_vilela.jpg`          |
| Jorge Braga       | `jorgebraga.jpg`         |
| André Moraes      | `andremoraes.jpg`        |
| Chico Martins     | `chicodopartido.jpg`     |
| Sônia Teles       | `soniateles.jpg`         |
| Bruno Teles       | `brunoteles.jpg`         |
| Helena Braga      | `helenabraga.jpg`        |
| Paulo Ferraz      | `pauloferraz.jpg`        |
| Nelson Reis       | `nelsonreis.jpg`         |
| Diego Braga       | `diegobraga.jpg`         |

## Formato

Quadradas (o corte para círculo é feito no CSS via `object-fit:cover`), a
partir de 96×96px. Acima de ~256px não ganha nada: a foto é exibida a 34px.

Se precisar usar `.png` em vez de `.jpg`, dá para apontar o caminho na mão
no campo `foto` da constante `CONC`, em `index.html`.
