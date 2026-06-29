// The catalogue of 100 VJ scenes, each with a distinct strength. Implemented scenes
// carry a `create` factory (playable); the rest are the planned roadmap, shown greyed
// in the index and filled in batch by batch. Scene 01 (LUMEN) ships as its own app and
// is linked via `href`.

import type { SceneDef } from "../engine/scene.ts";
import { createReaction } from "./reaction.ts";
import { createMoire } from "./moire.ts";
import { createTunnel } from "./tunnel.ts";
import { createWarp } from "./warp.ts";
import { createTerrain } from "./terrain.ts";
import { createVoronoi } from "./voronoi.ts";
import { createBars } from "./bars.ts";
import { createMatrix } from "./matrix.ts";
import { createFluid } from "./fluid.ts";
import { createClouds } from "./clouds.ts";
import { createGlitch } from "./glitch.ts";
import { createSpectrogram } from "./spectrogram.ts";
import { createMandelbrot } from "./mandelbrot.ts";
import { createAurora } from "./aurora.ts";
import { createAttractor } from "./attractor.ts";
import { createRings } from "./rings.ts";

interface Entry {
  no: string;
  title: string;
  family: string;
  blurb: string;
  create?: SceneDef["create"];
  href?: string;
  keys?: string;
}

type Planned = [string, string, string, string];

const E: (Entry | Planned)[] = [
  // ---- implemented ----
  {
    no: "01",
    title: "LUMEN",
    family: "particles",
    blurb:
      "周波数帯ごとに積層した約40万パーティクルの3D星雲。スペクトルが立体構造として読み取れる。",
    href: "./lumen/",
  },
  {
    no: "02",
    title: "REACTION",
    family: "reaction-diffusion",
    blurb:
      "Gray-Scott反応拡散。生命的なチューリングパターンが生成・崩壊する。低域と重心がfeed/killを横断し、キックが種を注入、noveltyで配色が変わる。",
    create: createReaction,
    keys: "[R] reseed",
  },
  {
    no: "03",
    title: "MOIRE",
    family: "fragment",
    blurb:
      "万華鏡状の極座標フィールド。鏡像セグメント・干渉リング・トルーシェの織りが、帯域で分割数と回転、低域でズーム、キックで反転と発光する。",
    create: createMoire,
  },
  {
    no: "04",
    title: "TUNNEL",
    family: "raymarch",
    blurb:
      "無限に続くネオントンネルの疾走。低域が飛行速度、キックが手前へ走る光のリングを射出、重心がネオンの色相を動かす。",
    create: createTunnel,
  },
  {
    no: "05",
    title: "WARP",
    family: "particles",
    blurb:
      "ハイパースペースのスターフィールド。キックごとにワープし、星が放射状のストリークに伸びる。低域が巡航速度、重心が色を染める。",
    create: createWarp,
  },

  // ---- roadmap (planned) ----
  {
    no: "06",
    title: "FLUID",
    family: "fluids",
    blurb:
      "本物の安定流体ソルバ(移流＋ヤコビ圧力射影)が色染料を押し流す。底のエミッタが煙を吹き上げ、帯域が渦を巻き、キックごとに明るい渦が炸裂する。",
    create: createFluid,
  },
  [
    "07",
    "BOIDS",
    "particles",
    "群れの飛翔(ボイド)。整列・結合・分離が音圧で揺らぐマーマレーション。",
  ],
  ["08", "NBODY", "particles", "重力多体シミュレーションの銀河。低域が重力、キックで星が散る。"],
  ["09", "RIBBONS", "particles", "カールノイズ場を流れる無数のリボン。帯域で太さと色が変わる。"],
  ["10", "VERLET", "physics", "Verletの紐と布。ビートで張力が走り、波打つ。"],
  ["11", "SPH", "fluids", "SPHの水滴。表面張力で結合・分裂するメタリックな流体。"],
  ["12", "MAGNET", "physics", "双極子場の砂鉄。磁力線が音で再配置される。"],
  ["13", "LIFE", "cellular", "ライフゲーム/Larger-than-Life。発火で新しいコロニーが芽吹く。"],
  ["14", "BZ", "reaction-diffusion", "Belousov-Zhabotinskyの化学振動。螺旋波が脈打つ。"],
  ["15", "CYCLIC", "cellular", "巡回セルオートマトン。色相の渦巻きが自己組織化する。"],
  ["16", "SLIME", "particles", "粘菌(physarum)のネットワーク。フェロモン跡が音で枝分かれ。"],
  ["17", "WAVES", "simulation", "波動方程式の水面。ビートが波紋を落とす。"],
  ["18", "SAND", "cellular", "落下する砂。帯域ウォーカーが粒を積み、キックで崩す。"],
  ["19", "DLA", "simulation", "拡散律速凝集。雷状・珊瑚状の結晶が音で成長する。"],
  ["20", "MANDELBULB", "raymarch", "3Dフラクタル・マンデルバルブ。powが音で脈動。"],
  ["21", "MENGER", "raymarch", "メンガーのスポンジを無限ズーム。低域で反復が増える。"],
  {
    no: "22",
    title: "TERRAIN",
    family: "raymarch",
    blurb:
      "稜線地形を低空飛行するレイマーチ。低域が山を隆起させ、スペクトルが起伏を波打たせ、重心が空と陽の配色を、キックが稜線の発光を脈打たせる。",
    create: createTerrain,
  },
  ["23", "METABALLS", "raymarch", "レイマーチのメタボール。ビートで分裂・融合。"],
  ["24", "GYROID", "raymarch", "ジャイロイド(TPMS)曲面の内部を進む。"],
  {
    no: "25",
    title: "CLOUDS",
    family: "raymarch",
    blurb:
      "高度のボリュメトリック雲。レイマーチした濃度場を太陽が照らし、低域が雲量を厚くし、重心が空と陽を染め、キックが雲の中で稲妻を閃かせる。",
    create: createClouds,
  },
  ["26", "OCEAN", "raymarch", "Gerstner波の海。うねりが低域で高まる。"],
  ["27", "CITY", "raymarch", "手続き型スカイラインのドライブ。ネオンが拍で点滅。"],
  ["28", "KIFS", "raymarch", "万華鏡IFSフラクタル。折り畳みが音で変形。"],
  ["29", "APOLLONIAN", "raymarch", "アポロニウスの球充填。重心で半径が変わる。"],
  {
    no: "30",
    title: "MANDELBROT",
    family: "fragment",
    blurb:
      "生きたジュリア集合。定数cが音に沿って動き、塵→渦巻き→樹状へと絶えずモーフ。levelが呼吸するズーム、重心が配色、高域が細部を増やす。連続反復彩色。",
    create: createMandelbrot,
  },
  ["31", "PLASMA", "fragment", "古典プラズマ。正弦の重ね合わせが帯域で波打つ。"],
  {
    no: "32",
    title: "VORONOI",
    family: "fragment",
    blurb:
      "セルラー・ボロノイの破砕。各セルが色付きの硝子片になり、音圧で漂い、高域で輪郭が鋭くなり、キックで全体が割れて色相が回る。",
    create: createVoronoi,
  },
  ["33", "TRUCHET", "fragment", "トルーシェ・タイルの織り。拍でパターンが組み変わる。"],
  ["34", "HEXGRID", "fragment", "六角セルの脈動。帯域がセルを点灯。"],
  ["35", "DOMAINWARP", "fragment", "fBmのドメインワープ。流体的なマーブル模様。"],
  ["36", "CAUSTICS", "fragment", "水面のコースティクス。光の網が揺らぐ。"],
  ["37", "INTERFERENCE", "fragment", "波の干渉縞。複数音源が拍で動く。"],
  ["38", "PHYLLOTAXIS", "fragment", "葉序の螺旋ドット。重心で開度が変わる。"],
  ["39", "GABOR", "fragment", "ガボールノイズの縞。方位が帯域で回る。"],
  {
    no: "40",
    title: "BARS",
    family: "geometry",
    blurb:
      "3Dスペクトラム・バーの都市。各周波数帯がリング上の光る柱になり、高さがその帯域のエネルギー。カメラが旋回し、床に反射する発光イコライザー。",
    create: createBars,
  },
  ["41", "TORUS", "geometry", "結ばれたチューブ(トーラス結び)。音で捻れる。"],
  ["42", "LISSAJOUS", "geometry", "3Dリサジュー曲線。周波数比が音で動く。"],
  ["43", "SUPERSHAPE", "geometry", "スーパーフォーミュラのモーフ。"],
  ["44", "PLATONIC", "geometry", "回転する正多面体のワイヤー。拍で切替。"],
  ["45", "RIBBONTRAIL", "geometry", "音に追従するリボンの軌跡。"],
  ["46", "LATTICE", "geometry", "変形する3D格子。低域で歪む。"],
  ["47", "SPHEREFIELD", "geometry", "インスタンス球の場。帯域で隆起。"],
  ["48", "TENTACLE", "raymarch", "SDFの触手群。音でうねる。"],
  ["49", "ASCII", "typography", "ASCIIスペクトラム。波形が文字に変換される。"],
  {
    no: "50",
    title: "MATRIX",
    family: "typography",
    blurb:
      "落下するグリフの雨。列ごとに輝く先頭と尾を引く軌跡が流れ、低域で雨脚が速まり、重心が色を染め、キックがランダムな列にバーストを走らせる。",
    create: createMatrix,
  },
  {
    no: "51",
    title: "GLITCH",
    family: "glitch",
    blurb:
      "データモッシュのフィードバック。前フレームがブロック変位とチャンネルずれで還流し、スペクトラムの帯が色を注入。スネアとキックで画面が裂け、反転・走査線が走る。",
    create: createGlitch,
  },
  ["52", "OSCILLOSCOPE", "scan", "オシロスコープ表示。波形がそのまま線になる。"],
  ["53", "SCOPE_XY", "scan", "X-Yリサジュー・スコープ。ステレオ的に揺れる。"],
  ["54", "TYPO", "typography", "キネティック・タイポグラフィ。語が拍で結晶化。"],
  ["55", "SLITSCAN", "glitch", "スリットスキャン。時間が空間に引き伸ばされる。"],
  ["56", "FEEDBACK", "feedback", "ビデオフィードバックの無限再帰。種図形が音で動く。"],
  ["57", "RUTTETRA", "scan", "Rutt-Etra走査線変位。輝度が起伏になる。"],
  ["58", "LASERS", "light", "ビームのグリッド。拍でスイープ。"],
  ["59", "STROBE", "light", "ストロボ・パターン。発火で明滅。"],
  ["60", "BOKEH", "light", "デフォーカスの光球。低域で被写界が呼吸。"],
  ["61", "PRISM", "light", "プリズム分光。白色が虹に割れる。"],
  {
    no: "62",
    title: "AURORA",
    family: "light",
    blurb:
      "星空にかかるオーロラのカーテン。fBmのリボンが波打ち、低域がカーテンを持ち上げ、高域が揺らめかせ、重心が緑↔紫の色相を動かし、キックが光の波を走らせる。",
    create: createAurora,
  },
  ["63", "GODRAYS", "light", "放射状の光芒。重心で射す方向が変わる。"],
  ["64", "NEONSIGN", "light", "明滅するネオン管。拍で点灯シーケンス。"],
  ["65", "KALEIDO_FB", "feedback", "フィードバック万華鏡。再帰像が回転対称に。"],
  ["66", "INK", "fluids", "水中のインク。拍で滴下し拡散。"],
  ["67", "FIRE", "fluids", "炎のシミュレーション。低域で燃え上がる。"],
  ["68", "SMOKE", "fluids", "浮力煙。音源から立ち上る。"],
  ["69", "LIGHTNING", "procedural", "枝分かれする稲妻。キックで放電。"],
  ["70", "CORAL", "simulation", "珊瑚の成長。音でブランチが伸びる。"],
  ["71", "VEINS", "simulation", "葉脈のオークラ-トロイ成長。"],
  ["72", "FUR", "fragment", "梳かれた毛皮の場。音で流れが変わる。"],
  ["73", "BUBBLES", "fragment", "石鹸膜の虹色干渉。厚みが音で揺れる。"],
  ["74", "SHEETS", "geometry", "流れる3Dシート。低域でうねる。"],
  ["75", "FLAG", "physics", "風になびく旗。突風が拍で吹く。"],
  ["76", "PENDULUM", "physics", "カオス二重振り子の群れ。軌跡が描かれる。"],
  ["77", "SPRINGMESH", "physics", "質点ばねメッシュ。発火で波が走る。"],
  {
    no: "78",
    title: "ATTRACTOR",
    family: "strange",
    blurb:
      "ローレンツのストレンジアトラクタを点群で。数千の粒子がカオス流に乗って蝶を描き、低域が翼(ρ)を広げ、levelが視点を回し、重心が雲を染める。",
    create: createAttractor,
  },
  ["79", "ROSSLER", "strange", "レスラー・アトラクタの軌道。"],
  ["80", "CLIFFORD", "strange", "クリフォード・アトラクタの点雲。"],
  ["81", "FIELDLINES", "fragment", "ベクトル場の流線。音で渦が動く。"],
  ["82", "WANG", "pattern", "ウォンタイルの非周期パターン。"],
  ["83", "PENROSE", "pattern", "ペンローズ・タイリング。拍で膨張。"],
  ["84", "GIRIH", "pattern", "ギリ(イスラム幾何)パターンの生成。"],
  ["85", "QUILT", "pattern", "生成的なキルト。帯域で配色。"],
  ["86", "STAINED", "pattern", "ステンドグラス状ボロノイ。光が透ける。"],
  ["87", "CIRCUIT", "pattern", "PCBの配線が音で引かれていく。"],
  ["88", "MAZE", "pattern", "成長する迷路。拍で経路が伸びる。"],
  {
    no: "89",
    title: "SPECTROGRAM",
    family: "spectral",
    blurb:
      "スクロールするスペクトログラムの滝。毎フレーム右端に最新の周波数列を書き、履歴が左へ流れる。音の直近の過去がヒートマップとして見える。重心で配色、キックで先頭が輝く。",
    create: createSpectrogram,
  },
  ["90", "RADIAL_EQ", "spectral", "放射スペクトラムの開花。"],
  ["91", "TERRAIN_FFT", "spectral", "スペクトラムが地形になり前進する。"],
  ["92", "PARTICLE_FFT", "spectral", "パーティクルで作るバーグラフ。"],
  ["93", "MANDALA", "spectral", "対称マンダラにスペクトラムを写す。"],
  ["94", "CYMATICS", "spectral", "クラドニ図形(振動板)。帯域で節が動く。"],
  {
    no: "95",
    title: "RINGS",
    family: "spectral",
    blurb:
      "同心ビートリング＋放射イコライザー。スペクトラムが円周に巻きつき(角度=周波数)、ラウドな帯域が外へ膨らみ、キックごとに明るい衝撃波リングが縁まで広がる。",
    create: createRings,
  },
  ["96", "TYPO_FIELD", "spectral", "エネルギー場CA上に文字が現れる。"],
  ["97", "KNOT", "geometry", "音で変形するトーラス結び目。"],
  ["98", "BLACKHOLE", "raymarch", "重力レンズのブラックホール。降着円盤が脈動。"],
  ["99", "WORMHOLE", "raymarch", "ワームホールを抜ける。"],
  ["100", "SUPERNOVA", "spectral", "フィナーレ。全帯域の超新星爆発。"],
];

export const SCENES: SceneDef[] = E.map((e) => {
  if (Array.isArray(e)) {
    const [no, title, family, blurb] = e;
    return { id: `${no}-${title.toLowerCase()}`, no, title, family, blurb };
  }
  return {
    id: `${e.no}-${e.title.toLowerCase()}`,
    no: e.no,
    title: e.title,
    family: e.family,
    blurb: e.blurb,
    create: e.create,
    href: e.href,
    keys: e.keys,
  };
});

export function findScene(id: string | null): SceneDef | undefined {
  return SCENES.find((s) => s.id === id);
}
