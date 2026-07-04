---
name: vj-scene-aesthetics
description: vj-sys(apps/gallery)のシーン=VJ素材を新規実装・改修・レビューするときに使う。「素材はこうあるべき」という美意識と合格ラインを判断層として与える。音→映像マッピング設計、ビート表現の可否、視認性/スケールの機械QA赤旗、マクロ契約・決定論・bindOutput の不可侵ルール、提出前チェックを案内する。機械的な追加手順は apps/gallery/SCENES.md が担うので、この skill はその上の「良し悪しの判断」を担当する。
---

# vj-scene-aesthetics

vj-sys の VJ 素材(=1シーン)が「良い素材」であるための規範。**手順・契約の詳細は
`apps/gallery/SCENES.md`**、閾値の根拠は `apps/gallery/src/engine/qa.ts` 冒頭コメント。
この skill はその上位の **判断層**(何を目指し、何を避け、どこで合格とするか)。

## いつ使うか

- 新しいシーンを実装する / 既存シーンを改修する
- シーンの音→映像マッピングやビート表現をレビューする
- QA の赤旗(WHITE / LOW_VIS / OVERSCALE / STATIC / KICK_WEAK …)を直す

## 最重要原則 — 音楽を「構造」で語る

**ビート/BPM をフラッシュ・キックズーム・ストロボ・白フラッシュで表さない。**
キック毎のピクつきは音楽理解を示さない安直な表現。素材の見せ場は、
アルゴリズムそのものの美しさと、**小節・フレーズ・楽曲構造への追従**。

| ✅ 目指す(構造で語る)                          | ❌ 避ける(拍でピクつく)               |
| ---------------------------------------------- | ------------------------------------- |
| フレーズ長(8〜16拍)の滑らかなエンベロープ      | kick 毎のズームパンチ・強アクセント   |
| tier / breakdown / drop / section での画の転換 | 白フラッシュ・全画面ストロボの多用    |
| 連続量(bass/level/centroid)のゆっくりした変調  | 生の瞬時値を直接明度・色にぶつける    |
| 自律運動があり、音は「味付け」                 | 音が止まると静止 / 音が来た時だけ動く |

drop や section 変化のような**構造イベント**でこそ大きく画を動かす。拍は「エンベロープ
(kickPulse 等)で軽く味付け」に留める。詳細な音シグナルの用法は SCENES.md の
「音シグナルカタログ」。

## 素材は「固定映像」でなく「楽器」— マクロ契約

シーンは `macros`(値 0..1、opt-in)で外から変調できるパラメトリックな楽器にする。
Live の Director が seed を低速ドリフトさせ、QA が 0.2/0.5/0.8 を掃引する。

不可侵ルール(QA の `MACRO_DEAD` と回帰比較が検証):

1. **未注入=従来と同一画**。uniform デフォルト 0 で無変調(例 `p + vec2(u_seed*37., -u_seed*23.)` は seed=0 で恒等)。
2. **連続写像**。近い値→近い画。`hash(seed)` のような離散写像は禁止(パン/位相/ドメインオフセットへ写す)。
3. GPGPU など状態を持つシーンの seed は再シード=状態リセットになりやすい → 表示系パラメータへ写す。

参照実装: `plasma.ts` / `truchet.ts` / `caustics.ts`。

## 音→映像マッピングの質 = シーンの質

- **最低3系統**を異なる視覚パラメータへ: 連続量1(ズーム/密度/速度)・トリガ1(状態変化)・位相or重心1。
- 生値を直接色に使わない。連続量は平滑値、色相は centroid のようなゆっくりした量で。
- kick/snare/hat は「そのフレームのみ1」= トリガ用途。発光は `*Pulse`(1→0減衰)で。

## 視認性・スケールの合格ライン(機械QAが判定)

loud キャプチャの低解像 luma で機械判定される。設計時点で満たしておく:

- **BLACK**: 無音でも真っ黒にしない(ベース模様を残す)
- **WHITE**: 白飛び(luma>0.97)を画面の 18% 未満に(眩しさ対策)
- **LOW_VIS**: 明部(luma>0.15)を 2% 以上。中央の小さな一塊だけにしない(被覆<25% × 低コントラスト × 単一塊支配で旗)
- **OVERSCALE**: ズームしすぎて巨大な無地シェイプにしない(ほぼ全面明部なのに輪郭ばかりでディテール無しは旗)
- **STATIC**: 音が鳴っている間、静止画にならない(自律運動+音反応)
- **KICK_WEAK**: kick の瞬間に静止時ノイズと明確に区別できる視覚変化を出す
- **SLOW**: 640×360 headless(SwiftShader)で 15ms/frame 以内

## 触ってはいけない不可侵ルール

- **bindOutput 契約**: 最終描画で `gl.bindFramebuffer(gl.FRAMEBUFFER, null)` 禁止。`ctx.bindOutput()` を使う。PostFX は `new PostFX(gl, tri, ctx.bindOutput)`。違反は QA の `nullBind` が検出。
- **決定論**: 同一 seed + 同一音 → 同一画/同一判定。シーン内で `performance.now()`/`Date.now()` を使わず `frame(t, dt)` の引数を使う。`Math.random()` は可(QA が固定)。
- **TS 制約**: erasableSyntaxOnly(parameter property / enum / namespace 禁止)。

## チェックリスト

制作前:

- [ ] SCENES.md の追加手順・命名規約(`create<Name>` 1本 export、registry 触らない)を確認
- [ ] 音→映像マッピングを3系統以上、構造(小節/フレーズ/tier)ベースで設計したか
- [ ] ビートを「ピクつき」でなく「構造の反映」で表しているか
- [ ] マクロを付けるなら 0 で恒等・連続写像になっているか

提出前(QA を回して赤旗ゼロに):

```sh
vp run gallery#dev                                  # dev サーバ(ポートは出力を確認)
node apps/gallery/qa/run.mjs http://localhost:<port>/ all   # 全シーン(~20秒)
open apps/gallery/qa-out/sheet.html                 # コンタクトシート目視
node apps/gallery/qa/compare.mjs qa-out/baseline.json qa-out/report.json  # 回帰比較
```

- [ ] QA が error 0(warn は理由を説明)。視認性/スケール赤旗ゼロ
- [ ] `?live&auto=qa&seed=42&shots=6,14,30` の Live スモークで破綻なし
- [ ] マクロ対応シーンを足した/変えたら `node apps/gallery/qa/profile.mjs` でプロファイル再生成しコミット

## 参照

- `apps/gallery/SCENES.md` — 追加手順・Scene契約・音シグナルカタログ・スペック様式
- `apps/gallery/src/engine/qa.ts` — 機械判定の閾値と較正手順(冒頭コメント)
- `plasma.ts` / `truchet.ts` / `caustics.ts` — マクロ実装の参照
