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
import { createSlime } from "./slime.ts";
import { createMandelbulb } from "./mandelbulb.ts";
import { createTruchet } from "./truchet.ts";
import { createOscilloscope } from "./oscilloscope.ts";
import { createBoids } from "./boids.ts";
import { createCaustics } from "./caustics.ts";
import { createPlatonic } from "./platonic.ts";
import { createCymatics } from "./cymatics.ts";
import { createPlasma } from "./plasma.ts";
import { createHexgrid } from "./hexgrid.ts";
import { createDomainwarp } from "./domainwarp.ts";
import { createInterference } from "./interference.ts";
import { createMenger } from "./menger.ts";
import { createMetaballs } from "./metaballs.ts";
import { createGyroid } from "./gyroid.ts";
import { createApollonian } from "./apollonian.ts";
import { createGabor } from "./gabor.ts";
import { createFieldlines } from "./fieldlines.ts";
import { createRadialEq } from "./radialeq.ts";
import { createMandala } from "./mandala.ts";

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
  {
    no: "07",
    title: "BOIDS",
    family: "particles",
    blurb:
      "3Dのマーマレーション。Reynoldsの群れ(分離・整列・結合)が低域で速まり、高域で旋回が締まり、キックで散り、重心が色づく。周回カメラが奥行きを見せる。",
    create: createBoids,
  },
  ["08", "NBODY", "particles", "重力多体シミュレーションの銀河。低域が重力、キックで星が散る。"],
  ["09", "RIBBONS", "particles", "カールノイズ場を流れる無数のリボン。帯域で太さと色が変わる。"],
  ["10", "VERLET", "physics", "Verletの紐と布。ビートで張力が走り、波打つ。"],
  ["11", "SPH", "fluids", "SPHの水滴。表面張力で結合・分裂するメタリックな流体。"],
  ["12", "MAGNET", "physics", "双極子場の砂鉄。磁力線が音で再配置される。"],
  ["13", "LIFE", "cellular", "ライフゲーム/Larger-than-Life。発火で新しいコロニーが芽吹く。"],
  ["14", "BZ", "reaction-diffusion", "Belousov-Zhabotinskyの化学振動。螺旋波が脈打つ。"],
  ["15", "CYCLIC", "cellular", "巡回セルオートマトン。色相の渦巻きが自己組織化する。"],
  {
    no: "16",
    title: "SLIME",
    family: "particles",
    blurb:
      "粘菌(Physarum)シミュレーション。約10万のエージェントがフェロモン跡を嗅ぎ取り堆積させ、拡散・減衰しながら生きた輸送ネットワークへ自己組織化する。低域が速度と堆積、高域がセンサー角、キックで散乱する。",
    create: createSlime,
    keys: "[R] reseed",
  },
  ["17", "WAVES", "simulation", "波動方程式の水面。ビートが波紋を落とす。"],
  ["18", "SAND", "cellular", "落下する砂。帯域ウォーカーが粒を積み、キックで崩す。"],
  ["19", "DLA", "simulation", "拡散律速凝集。雷状・珊瑚状の結晶が音で成長する。"],
  {
    no: "20",
    title: "MANDELBULB",
    family: "raymarch",
    blurb:
      "古典3DフラクタルのマンデルバルブをDEレイマーチ。べき指数が低域で呼吸して開閉し、カメラが周回、重心が虹色の陰影、キックが表面を閃かせる。",
    create: createMandelbulb,
  },
  {
    no: "21",
    title: "MENGER",
    family: "raymarch",
    blurb:
      "折り畳み距離推定でレイマーチするメンガーのスポンジ。周回カメラで回転し、levelが公転と自転を速め、低域がカメラを引き寄せ折り目を脈動させ、重心が配色、高域が鏡面、キックが表面を閃かせる。",
    create: createMenger,
  },
  {
    no: "22",
    title: "TERRAIN",
    family: "raymarch",
    blurb:
      "稜線地形を低空飛行するレイマーチ。低域が山を隆起させ、スペクトルが起伏を波打たせ、重心が空と陽の配色を、キックが稜線の発光を脈打たせる。",
    create: createTerrain,
  },
  {
    no: "23",
    title: "METABALLS",
    family: "raymarch",
    blurb:
      "smooth-minで融合する6つの有機的メタボールをレイマーチ。低域が融合の粘りを深め、キックで球が外へ散り、帯域が各球の半径を脈打たせ、重心が虹色の配色、高域がフレネルと鏡面を鋭くする。",
    create: createMetaballs,
  },
  {
    no: "24",
    title: "GYROID",
    family: "raymarch",
    blurb:
      "終わりなきジャイロイド(TPMS)格子をカメラが前進飛行する。低域がセル密度を詰めて脈動させ、levelが飛行速度、高域が壁を薄く鋭くし、重心が玉虫色のパレットを染め、キックが面を閃かせる。",
    create: createGyroid,
  },
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
  {
    no: "29",
    title: "APOLLONIAN",
    family: "raymarch",
    blurb:
      "アポロニウスの球充填フラクタルをレイマーチ(IQ)。空間に無限入れ子の球が詰まり、重心が折り畳みスケールを変えて充填密度を作り替え、低域が構造を手前へ脈動させ、levelが周回、キックが表面を閃かせる。",
    create: createApollonian,
  },
  {
    no: "30",
    title: "MANDELBROT",
    family: "fragment",
    blurb:
      "生きたジュリア集合。定数cが音に沿って動き、塵→渦巻き→樹状へと絶えずモーフ。levelが呼吸するズーム、重心が配色、高域が細部を増やす。連続反復彩色。",
    create: createMandelbrot,
  },
  {
    no: "31",
    title: "PLASMA",
    family: "fragment",
    blurb:
      "古典デモシーンのプラズマをスペクトル場として再構築。正弦波の重畳にsnoiseのドメインワープを混ぜた有機的な流れを鮮烈なパレットで彩る。levelが速度、低域がコントラスト、帯域が空間周波数を変調し、重心が色相、高域が微細な波紋、キックが中心から発光する。",
    create: createPlasma,
  },
  {
    no: "32",
    title: "VORONOI",
    family: "fragment",
    blurb:
      "セルラー・ボロノイの破砕。各セルが色付きの硝子片になり、音圧で漂い、高域で輪郭が鋭くなり、キックで全体が割れて色相が回る。",
    create: createVoronoi,
  },
  {
    no: "33",
    title: "TRUCHET",
    family: "fragment",
    blurb:
      "流れるトルーシェの織り。各セルが四分円弧をランダムに置き、線が編み合って無限の迷路状ループになる。帯域が線幅と発光、場が回転・スクロールし、キックでセルの帯が反転する。",
    create: createTruchet,
  },
  {
    no: "34",
    title: "HEXGRID",
    family: "fragment",
    blurb:
      "脈動する六角セルのグリッド。各セルが周波数帯のエネルギーで点灯し(中心=低域、外周=高域)、低域でグリッドが呼吸し、キックごとに明るいリングがセルを走り抜け、高域が縁を細く鋭くし、重心が配色を染める。",
    create: createHexgrid,
  },
  {
    no: "35",
    title: "DOMAINWARP",
    family: "fragment",
    blurb:
      "Inigo-Quilez流のfBmドメインワープ。2段の歪みが場を自身へ折り込み、二度と繰り返さない液状マーブル/星雲を生む。levelが流れ、低域が乱流の深さ、変化が場の原点を漂わせ、重心が色相、高域がフィラメントを鋭くし、キックが発光する。",
    create: createDomainwarp,
  },
  {
    no: "36",
    title: "CAUSTICS",
    family: "fragment",
    blurb:
      "プール底で踊る光。層状の動的セルノイズが明るいコースティクスの網を編み、levelが流れを速め、低域が水の色を深め、高域がフィラメントを鋭くし、キックで波紋が走る。",
    create: createCaustics,
  },
  {
    no: "37",
    title: "INTERFERENCE",
    family: "fragment",
    blurb:
      "リップルタンク。6つの円形波源が同心円を放ち、その重ね合わせが動くモアレ干渉縞を描く。低域がリング密度、levelが伝播速度、帯域が各波源の振幅を脈打たせ、キックで波源が揺らぎ新たなリングが広がり、高域が縞を鋭くし、重心が配色を染める。",
    create: createInterference,
  },
  ["38", "PHYLLOTAXIS", "fragment", "葉序の螺旋ドット。重心で開度が変わる。"],
  {
    no: "39",
    title: "GABOR",
    family: "fragment",
    blurb:
      "ノイズが方位を操る配向ストライプ場。局所的に平行な帯が刷毛目/木目のように空間で渦巻く。低域が縞の密度、midが場全体の回転、levelがスクロール、高域が直交スパークルと稜線の鋭さ、重心が色相、キックが発光する。",
    create: createGabor,
  },
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
  {
    no: "44",
    title: "PLATONIC",
    family: "geometry",
    blurb:
      "回転する正多面体のワイヤーフレーム。ネオンの檻(正四面体→立方体→正八面体→正二十面体)が宙で回り、levelが回転、低域がスケールを脈打たせ、noveltyで次の立体へ切替わる。",
    create: createPlatonic,
  },
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
  {
    no: "52",
    title: "OSCILLOSCOPE",
    family: "scan",
    blurb:
      "CRTベクトルスコープ。生の音声波形を発光するリン光のリングに巻きつけ(半径=信号)、音そのものが描く軌跡を見る。低域がリングを膨らませ、levelがビームを輝かせ、重心がリン光を染める。",
    create: createOscilloscope,
  },
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
  {
    no: "81",
    title: "FIELDLINES",
    family: "fragment",
    blurb:
      "動くノイズ流れ場の流線。各ピクセルが場に沿って前後に積分するLIC近似で、磁力線のように輝く流線が現れる。低域が渦の大きさと流線長、levelが流速、変化が渦を再編成し、高域が線を鋭くし、重心が色相、キックが発光する。",
    create: createFieldlines,
  },
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
  {
    no: "90",
    title: "RADIAL_EQ",
    family: "spectral",
    blurb:
      "放射イコライザーの開花。24帯域が円周に巻きつき上下対称の花弁として咲き、各花弁の長さがその帯域のエネルギー。キックごとに同心リングが中心から広がり、低域でコアが脈動し、重心が配色、高域が花弁の先端を煌めかせる。",
    create: createRadialEq,
  },
  ["91", "TERRAIN_FFT", "spectral", "スペクトラムが地形になり前進する。"],
  ["92", "PARTICLE_FFT", "spectral", "パーティクルで作るバーグラフ。"],
  {
    no: "93",
    title: "MANDALA",
    family: "spectral",
    blurb:
      "スペクトラムを同心リングの花弁に写す対称マンダラ。N回対称＋鏡映で各半径リングが帯域に対応し、そのエネルギーで花弁が開く。低域でマンダラが呼吸し、変化で対称数が組み替わり、高域がフィリグリーを細かくし、キックで中心の宝石が閃く。",
    create: createMandala,
  },
  {
    no: "94",
    title: "CYMATICS",
    family: "spectral",
    blurb:
      "クラドニの振動板。定在波モード(m,n)が干渉し、板が静止する節線に砂が集まって対称図形を描く。帯域がモード数を駆動して模様が再構成され、キックで板が鳴り、重心が砂を染める。",
    create: createCymatics,
  },
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
