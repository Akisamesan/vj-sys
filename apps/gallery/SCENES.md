# シーン制作ガイド

100シーンVJコレクションにシーンを追加する実装者(人間・エージェント問わず)向けの規約。
これを読めば registry や engine の再調査なしで1シーンを完結できる。

## 追加手順(配線不要)

1. `src/scenes/<name>.ts` を作る。`<name>` は registry のエントリ title を
   `toLowerCase()` して `_` を除いたもの(例: `TYPO_FIELD` → `typofield.ts`)。
2. `export function create<Name>(ctx: SceneContext): Scene` を1つだけ export する
   (`create` で始まる export 関数が自動配線される。ヘルパーは export しない)。
3. **registry.ts は触らない。** `import.meta.glob` がファイル名規約で自動配線する。
   Planned タプルのままでも即再生可能になる。blurb を充実させたい場合のみ
   タプルを rich エントリに昇格させる(`intensity: 1|2|3` も付けると Live の
   Director が選曲に使う。1=静穏 2=グルーヴ 3=ピーク)。
4. QAを回して通す(下記)。

## Scene 契約(engine/scene.ts)

```ts
interface Scene {
  resize(w, h): void; // マウント時+リサイズ時
  frame(t, dt, audio: AudioEngine): void; // 毎フレーム描画
  key?(k): boolean; // 任意: キー操作
  macros?: Partial<Record<MacroName, (v: number) => void>>; // 任意: 外部変調(下記)
  dispose?(): void; // 通常不要(GLScopeが回収する)
}
```

### マクロ契約(外部変調・opt-in)

`macros` はシーンを「固定映像」から「パラメトリックな楽器」にする任意の受け口。
Live の Director と QA 掃引が外側から呼ぶ。**既存シーンは無改修で動く**(未実装なら省略)。

```ts
macros?: Partial<Record<MacroName, (v: number) => void>>; // 値は 0..1
```

| マクロ    | 意味                                                    |
| --------- | ------------------------------------------------------- |
| `seed`    | シーンの「顔」。ノイズドメイン/パレット位相のオフセット |
| `energy`  | 全体強度(発光・振幅)                                    |
| `hue`     | パレット回転                                            |
| `density` | ディテール密度(セル数・粒子数の見かけ)                  |
| `chaos`   | 乱流・無秩序度                                          |
| `zoom`    | カメラ/フィールドのスケール                             |

実装規則(QA の `MACRO_DEAD` と回帰比較が検証する):

1. **未注入時は従来と同一の画**。uniform デフォルト 0 で無変調になる設計にする
   (例: `p + vec2(u_seed*37.0, -u_seed*23.0)` は seed=0 で恒等)。
2. **連続写像にする**。Live は seed を低速ドリフトさせるため、近い値→近い画
   でないと画がカット的に飛ぶ。`hash(seed)` のような離散写像は禁止
   (パン・位相・ドメインオフセットに写す)。
3. 定石は `u_seed` uniform 1個: ドメインオフセット+パレット位相+軌道位相。
   参照実装: `plasma.ts` / `truchet.ts` / `caustics.ts`。
4. 状態を持つシーン(GPGPU)の seed は再シード=状態リセットになりがちなので、
   表示系パラメータへの写像を優先する(ドリフト耐性のため)。

Live の駆動: カット時に seed を注入し、再生中は ±0.012/s で 0..1 を反射
ドリフト。QA は seed 対応シーンだけ 0.2/0.5/0.8 の3枚を `sheet.html` に出す。

## bindOutput 契約

**絶対規則: 最終描画パスでは `gl.bindFramebuffer(gl.FRAMEBUFFER, null)` を使わない。**
代わりに `ctx.bindOutput()` を呼ぶ(bind+viewport を行う)。Live モードはこれで
シーンをオフスクリーンチャンネルへ回してミックスする。PostFX を使う場合は
`new PostFX(gl, tri, ctx.bindOutput)` と第3引数に渡す。中間パス(自前FBO)は自由。
違反は QA の `nullBind` カウンタが検出する。

## 実装3パターン(参照実装)

| パターン            | 参照                                  | 用途                                      |
| ------------------- | ------------------------------------- | ----------------------------------------- |
| fragment 1パス      | `caustics.ts`(73行)                   | 数式・ノイズ・SDFのフルスクリーンシェーダ |
| プリミティブ+PostFX | `platonic.ts`(GL_LINES+bloom)         | 線・点の幾何をHDR bloomで発光させる       |
| ping-pong GPGPU     | `slime.ts`, `reaction.ts`, `fluid.ts` | 状態を持つシミュレーション                |

共通ヘルパー: `engine/gl.ts`(program/uniforms/texture/framebuffer/FULLSCREEN_VS)、
`engine/glsl.ts`(COMMON_GLSL: hash/snoise/curlNoise/palette)、`engine/postfx.ts`。

## 音シグナルカタログ(AudioEngine)と用法

| シグナル                        | 型                 | 使い方の定石                                       |
| ------------------------------- | ------------------ | -------------------------------------------------- |
| `bass/mid/high/level`           | 平滑 0..1          | 連続量(ズーム・密度・速度)。生値を直接色に使わない |
| `kick/snare/hat`                | そのフレームのみ 1 | 状態変化のトリガ(シード注入・反転・切替)           |
| `kickPulse/snarePulse/hatPulse` | 1→0 減衰           | 発光・衝撃波・パンチなど視覚エンベロープ           |
| `spectrum[24]`                  | log配置 平滑       | 空間に埋め込む(角度=帯域、高さ=強度)               |
| `wave[512]`                     | -1..1              | オシロスコープ・波形描画                           |
| `centroid`                      | 明るさ重心 0..1    | 色相・温度感のゆっくりした変調                     |
| `novelty/change`                | 楽曲変化           | レジーム切替(配色・モード変更)                     |
| `bpm/beatPhase/barPhase`        | テンポ位相         | ビート同期アニメーション(カメラ・脈動)             |
| `beatEnvelope`                  | 1→0 各拍           | キック未検出でも使える拍エンベロープ               |

マッピングの質が シーンの質。最低3系統(連続量1・トリガ1・位相or重心1)を
異なる視覚パラメータに割り当てること。

## 品質基準(QAが機械判定する)

- **BLACK**: 無音でも真っ黒にしない(ベース模様を残す)
- **WHITE**: 白飛び画素(luma>0.97)を 18% 未満に(眩しさ対策)
- **STATIC**: 音が鳴っている間、静止画にならない(自律運動+音反応)
- **KICK_WEAK**: kick の瞬間に静止時ノイズと明確に区別できる視覚変化を出す
- **SLOW**: 640×360 headless(SwiftShader)で 15ms/frame 以内
  (fragmentなら余裕。raymarchはステップ数注意)
- **LOW_VIS**: 明部(luma>0.15)を画面の 2% 以上に。中央の小さな一塊だけで
  構成しない(被覆25%未満 × 低コントラスト × 単一塊支配で旗が立つ)
- **OVERSCALE**: ズームしすぎて巨大な無地シェイプだけにしない(ほぼ全面明部
  なのに輪郭ばかりでディテールが無いと旗が立つ)
- **nullBind = 0**: `ctx.bindOutput()` 契約の遵守
- resize 後も破綻しない(FBOの再確保は `resize()` 内で)

視認性系(WHITE/LOW_VIS/OVERSCALE)は loud キャプチャの 240×135 luma で判定する。
閾値の根拠と較正手順は `engine/qa.ts` 冒頭の定数コメントを参照。既知の限界:
微小パーティクルの「実機フル解像度では薄すぎる」問題(07 BOIDS)は 640×360 の
QA では再現されないため機械判定できない。

制約: TS は erasableSyntaxOnly(parameter property / enum / namespace 禁止)。
`Math.random()` は使用可(QAがシード固定する)。`performance.now()`/`Date.now()` は
シーン内で使わず、`frame(t, dt)` の引数を使う。

### 赤旗別・定番回避レシピ

QAを回せない分業(共有devサーバ/qa-out衝突回避)では、赤旗は実装時に構造で
潰すしかない。バッチ1(10シーン中5赤旗、うち4件が下記)の実測に基づく定番。

| 赤旗                     | 定番の落とし穴                                                                                                                            | 回避レシピ                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LOW_VIS(細線系)          | QAはheadless SwiftShader(640×360)で走り `gl.lineWidth` が効かない。GL_LINES 1pxは実機で見えてもQAでは消える                               | 線は法線オフセットしたクアッド(三角形2枚)に展開する。参照: `ribbons.ts`(09 RIBBONS)/ `verlet.ts`(10 VERLET)                                                                                 |
| LOW_VIS(加算ポイント系)  | パレット×深度×質量などの係数の積は想像より暗くなる                                                                                        | 輝度倍率(×2程度)を明示的に掛け、点サイズも640×360で読める大きさに。**bloomで誤魔化さない**(全面が白い霞になりcovは通るが絵が死ぬ。08 NBODYで実証済み)。coverageは粒子数を増やす正攻法で稼ぐ |
| WHITE(白飛び18%超)       | 加算のエッジ強調・ハイライト(`col += vec3(0.9,...) * edge` 系)は境界が多い画面で全面白飛びする                                            | `mix()` による強調に置き換える                                                                                                                                                              |
| CA・自己組織化系の初期化 | 単一テクセル乱数からの粗大化(coarsening)は√世代でしか進まず、384²だと数千世代かかる。起動時warmup数百回では足りない                       | 粗いブロック乱数(例: 20×20を最近傍拡大)で初期化し、CAには既存構造の変形・侵食をやらせる(15 CYCLICで実証済み)                                                                                |
| 飽和・DCドリフト         | 正のみの常時注入(ドリップ等)は場の平均値を漂わせ、数十秒で色マップが飽和し構造が消える                                                    | 微小な減衰(×0.9985/frame等)で平均をゼロ近傍に保つ(17 WAVESで実証済み)                                                                                                                       |
| KICK_WEAK                | 賑やかな場ではkickの構造的トリガ(種注入等)が視覚的に埋もれてkickΔが立たない                                                               | 注入位置に減衰する局所グロー(`exp(-d²k)×kickPulse`)を添える。フラッシュ無しでkick応答が読める(15 CYCLICで実証済み)                                                                          |
| LOW_VIS⇔WHITEの往復      | 太さ・輝度・bloomを強気に足してから削ると、2〜3往復して収束が遅い(43 SUPERSHAPEで実測: LOW_VIS→白飛びで形状が読めない→LOW_VIS再発→微調整) | 太さ・輝度・bloomは最小(明らかに薄いと分かる値)から始め、`vp check`+目視で少しずつ足す。引き算より足し算の方が往復が少ない                                                                  |

## QA の回し方

```sh
vp run gallery#dev                          # devサーバ(例: :5199)
node qa/run.mjs http://localhost:5199/ <id> # 1シーン(例: 96-typo_field)
node qa/run.mjs http://localhost:5199/ all  # 全シーン(~20秒)
open qa-out/sheet.html                      # コンタクトシート目視
node qa/compare.mjs qa-out/baseline.json qa-out/report.json  # 回帰比較
```

**`<id>` は `title.toLowerCase()`(アンダースコアは保持)。** ファイル名解決
(`src/scenes/<name>.ts`)はアンダースコアを除去するが、registry.ts の
Planned/rich エントリの `id` は除去しない。つまり `SCOPE_XY` はファイル
`scopexy.ts` だが QA の `<id>` は `53-scope_xy`(例: 96-typo_field も同様)。
ファイル名から誤って `53-scopexy` を渡すとエラーにならず黙って
"0 scenes" になるだけなので、0件になったらまずこの命名規則ズレを疑う。

ブラウザで `?qa=<id>` を開けば同じ計測をインタラクティブに確認できる。
Live のスモークは `?live&auto=qa&seed=42&shots=6,14,30` → `qa-out/live-*.jpg` と
遷移ログ `live-report.json`(カットに加え blend-hold の `hold:*` イベントも記録。
`auto=qa` は適格セグメントで hold を強制し FPS ガードを無効化するので決定論)。

QA 実行後は Director 用プロファイル(blend-hold のペア選定に使う cost/luma)を
再生成してコミットする:

```sh
node qa/profile.mjs   # qa-out/report.json → src/scenes/profile.gen.ts
```

## スペック様式(ディレクター→実装者)

発注スペックは以下だけで足りる(契約・QA・制約はこのファイルが担う):

```
シーン: <no> <TITLE>(family)
コンセプト: 1〜3文。何が「見どころ」か
技法: パターン(fragment / lines+PostFX / GPGPU)と核になる数理
音→映像マッピング表: シグナル → パラメータ → 視覚効果(3行以上)
パレット: 基調色と変調方針(COMMON_GLSLのpalette推奨)
制約: 負荷上限・パス数など特記事項
```

### 標準発注ブロック

サブエージェントに発注する際は、上記スペックの前に以下を必ず貼る
(詳細はこのファイルの各節が担うので、ここは要点+参照のみ):

```
- apps/gallery/SCENES.md を最初に読むこと(契約・レシピ・品質基準はそこにある)
- ファイルは src/scenes/<name>.ts 1つだけ新規作成。create* を1つだけexport
  し、registry.ts は編集禁止
- 最終描画は ctx.bindOutput()(PostFXは第3引数)
- erasableSyntaxOnly(enum/namespace/parameter property禁止)
- ビート規範: フラッシュ/ストロボ/ピクつきでBPMを表さない。kickは構造的トリガに
- performance.now()/Date.now() 禁止(frameのt/dtを使う)
- 検証は vp check のみ(指摘は自ファイルへのパス限定 --fix は可、全体--fix禁止)。
  devサーバ起動・qa/run.mjs 実行は禁止(共有リソース。QAはディレクターが一括実行)
- 完了報告: ファイルパス・技法・音マッピング要約・vp check結果を150字程度
```
