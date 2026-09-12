# change-record リアルタイム記録手順 / Real-time change-record procedure

このドキュメントは CHANGE-0001 / CHANGE-0004 で発生した恒久的な
`change-history` / `change-completeness` ゲート失敗（事後一括記録による
`CHANGE_*_UNCHANGED` エラー、および `--requirement` 列挙漏れ）を二度と
起こさないための、次回以降の change 作業での実行手順です。
`sdd-change` スキルの既存ルールを補足する運用チェックリストであり、
スキル本体を置き換えるものではありません。

## 1. なぜ事後一括記録が恒久的に壊れるか（根本原因）

`musubix3 change-record` は各フェーズ実行時点での関連ファイル（
`requirements.md` / `design.md` / ADR / テスト / 実装コード、trace で該当
要求IDに紐づくファイル群）の内容ハッシュ（fingerprint）をそのフェーズの
証跡として保存します。

- `requirements` フェーズは「`impact` 記録時点」と「`requirements` 記録時点」
  の fingerprint が異なることを要求します（＝impact 記録後に本当に
  requirements.md を編集してから requirements を記録する必要がある）。
- 同様に `design` は requirements 記録後に design.md/ADR が変化していること、
  `implementation` は red 記録後に実装コードが変化していること、を要求します。
- 各フェーズは **1 changeにつき1回だけ** 記録可能で、上書き・削除・リセット
  する CLI コマンドは存在しません（append-only）。
- `--requirement` に渡す ID 集合は **`impact` フェーズで確定** し、以降の
  `requirements`/`design`/`quality` は必ずその全集合と完全一致している
  必要があります（部分集合や超集合は拒否されます）。`red`/`implementation`/
  `green` のみ、その全集合の非空な部分集合を「要求ごとのバッチ」として
  独立記録できます。

→ 実装が全部終わった後に7フェーズをまとめて数秒以内に記録すると、
どの2フェーズ間もファイル内容が変化していないため
`CHANGE_REQUIREMENTS_UNCHANGED` / `CHANGE_DESIGN_UNCHANGED` /
`CHANGE_IMPLEMENTATION_UNCHANGED` / `CHANGE_RELEVANT_IMPLEMENTATION_UNCHANGED`
が発生し、これは append-only 制約のため二度と修復できません。

## 2. 実行タイミング（必須・フェーズ完了の直後に都度実行）

`sdd-change` スキルの `## 1〜4` の各ステップを実施する**その場で**、
以下の順序どおりに `change-record` を呼び出すこと。まとめて後で記録しない。

| フェーズ | 実行タイミング | 直前に必要な変化 |
|---|---|---|
| `impact` | CHANGE ドキュメント (`.musubix/changes/CHANGE-xxxx.md`) を作成した直後 | ドキュメント自体が新規作成されていること |
| `requirements` | `requirements.md` を編集し、要求バリデーションと rubber-duck レビューが通った直後（設計に着手する前） | `requirements.md` の内容が impact 記録時点から変化 |
| `design` | `design.md`/ADR を編集し、設計バリデーションと rubber-duck レビューが通った直後（実装/Redに着手する前） | `design.md`/ADR の内容が requirements 記録時点から変化 |
| `red` | 各要求(またはバッチ)の失敗テストを書き、`tdd red` を記録した直後 | テストファイルが design 記録時点から変化 |
| `implementation` | そのテストを通す最小実装を書いた直後（`tdd green` の前） | 該当要求に紐づく実装コードが red 記録時点から変化 |
| `green` | `tdd green` を記録した直後 | （green 自体はテスト結果のみ、fingerprint は implementation 後の状態） |
| `quality` | 全要求の Green が揃い、`gate --changed` 相当のチェックが通った最終品質確認の直後 | 全要求バッチが green 済みであること |

複数要求を含む変更では、`red`/`implementation`/`green` は要求ごとに
バッチとして都度記録してよい（インターリーブ実装ループ）。ただし
`impact`/`requirements`/`design`/`quality` は必ずその変更の全要求ID
セットで一度だけ記録する。

## 3. `--requirement` 列挙チェック（必須・impact 記録前に確認）

`impact` を記録する**前**に、次を必ず突き合わせる:

```bash
grep -A2 '^Requirements:' .musubix/changes/CHANGE-xxxx.md
```

ここに列挙された ID **全部**を `impact` の `--requirement` に渡すこと。
1つでも漏れると、後続フェーズすべてで固定される要求ID集合が不完全になり、
`quality` 段階で `CHANGE_COMPLETENESS_*` 系の恒久的な不整合になる
（CHANGE-0004 では `REQ-MULTIUSER-008` の漏れがこれで発生した）。

## 4. 実行コマンド例（そのままコピーして使う）

```bash
# 1) CHANGE ドキュメント作成直後
npx musubix3 change-record CHANGE-000X impact --requirement REQ-A REQ-B REQ-C --json

# 2) requirements.md 編集・レビュー通過直後
npx musubix3 change-record CHANGE-000X requirements --requirement REQ-A REQ-B REQ-C --json

# 3) design.md/ADR 編集・レビュー通過直後
npx musubix3 change-record CHANGE-000X design --requirement REQ-A REQ-B REQ-C --json

# 4) REQ-A について Red → Green を実装した直後（要求ごとのバッチ）
npx musubix3 change-record CHANGE-000X red --requirement REQ-A --json
#   ... 最小実装 ...
npx musubix3 change-record CHANGE-000X implementation --requirement REQ-A --json
npx musubix3 change-record CHANGE-000X green --requirement REQ-A --json
# REQ-B, REQ-C も同様に個別バッチとして繰り返す

# 5) 全要求の green が揃い、品質ゲート確認後
npx musubix3 change-record CHANGE-000X quality --requirement REQ-A REQ-B REQ-C --json
```

## 5. 途中経過の自己点検

各フェーズ記録直後、`.musubix/evidence/changes.json` の当該 change の
`phases.<phase>.order` が単調増加していること、及び直前フェーズと
`recordedAt` が近すぎない（＝間に実際の編集作業が挟まっている）ことを
目視確認する。まとめて記録した形跡（同一タイムスタンプ秒が並ぶ）が
あれば、その時点で `gate --changed` を実行し `change-history`/
`change-completeness` の診断が出ていないか早期に確認する。

## 6. 本手順の適用範囲

- 新規 CHANGE を開始する際は、`sdd-change` スキルの各ステップの
  「その場で」実行する一部として本手順のコマンドを組み込むこと。
- 既存の恒久的にブロックされた CHANGE（CHANGE-0001, CHANGE-0004）を
  遡って修復することはできない（append-only のため）。これらは
  `workflow`/`change-history`/`change-completeness` が failing のまま
  である事実を記録として受け入れる。
