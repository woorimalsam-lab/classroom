# -*- coding: utf-8 -*-
"""
강원교육 글꼴 → 웹폰트(WOFF2) 생성 스크립트

사용법:  python tools/build-fonts.py
필요:    pip install fonttools brotli
입력:    SRC_DIR 의 원본 TTF
출력:    fonts/*.woff2  +  fonts.css  (둘 다 덮어씀)

굵기를 바꾸고 싶으면 아래 FACES 의 파일명만 바꾸면 됩니다.
예) 본문을 얇게: ("GangwonAll", 400, "강원교육모두 Light.ttf", True)
"""
import os, sys
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

ROOT    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = r"C:/Users/admin/Desktop/김수연/폰트"
OUT_DIR = os.path.join(ROOT, "fonts")

# (CSS 글꼴이름, 굵기(범위 가능), 원본 TTF, 2단계(드문 글자) 파일도 만들지)
# 굵기를 "400 700" 처럼 범위로 주면 한 파일이 두 굵기를 모두 담당합니다(중복 다운로드 없음).
FACES = [
    ("GangwonAll",    "400 700", "강원교육모두 Bold.ttf",  True),   # 본문 기본 — 굵게
    ("GangwonPower",  "400 700", "강원교육튼튼.ttf",       True),   # 제목·큰 숫자
    ("GangwonHand",   "400 700", "강원교육현옥샘.ttf",     False),  # 손글씨 포인트
    ("GangwonSaeeum", "400 700", "강원교육새음.ttf",       False),  # 급식 식단
]

# 1단계에 포함할 상용 음절 (조사·어미·흔한 낱말·이름 음절)
COMMON = """
가각간갈감갑값강갖같개객거건걸검것게겨격견결경계고곡곤골곰곱공과관광교구국군굴굽권귀규균그극근글금급긋기긴길김깊까깎깐깔깜깝께꼬꼭꽃꾸꿈끄끈끊끌끔끝끼
나낙난날남납낫낭내냉너넉널넘넣네녀년념녕노녹논놀놈농높놓뇌누눈눌느는늘능늦니님
다단닫달담답당대댁더덕던덜덤덥데도독돈돌돕동되된두둑둘둠둥뒤드득든듣들듬등디딩따딱딸땀땅때떠떡떨떻또똑뚜뚫뛰뜨뜩뜰뜻띄
라락란람랑래랜량러럭런럼럽렁렇레려력련렬렵령례로록론롬롭롱뢰료루룹룻류륙률륭르른를름릇리린림립
마막만많말맑맛망맞맡매맥맨맺머먹먼멀멈멋메며면멸명몇모목몸못몽묘무묵문묻물뭇뭐미민믿밀밑
바박밖반받발밝밤밥방배백뱀버번벌범법벗베벤벼변별병보복본볼봄봉뵙부북분불붉붓붙브블비빌빗빛빠빨빵빼뻐뽑뿐
사삭산살삼상새색생서석선설섬섭성세센셔소속손솔솜송쇄쇠수숙순술숨숫숭쉬쉽슈스슨슬슴습승시식신실싫심십싯싱싶싸쌀쌍쌓써썩쎄쏘쑤쓰쓸씀씌씨
아악안앉않알암압앗았앙앞애액야약얀얄얇양얕어억언얻얼엄업없엇었엉에여역연열염엽영옆예옛오옥온올옮옴옷와완왕왜외왼요욕용우욱운울움웃웅워원월웨위윈유육윤율으은을음응의이익인일읽잃임입잇있잊잎
자작잔잘잠잡장재쟁저적전절젊점접젓정제젠젼조족존졸좀종좋좌죄주죽준줄줌중쥐즈즉즐즘증지직진질짐집짓징짜짝째쪽쫓찌찍찢
차착찬찮찰참창찾채책처천철첫청체초촉촌총최추축춘출춤충취측층치친칠침칭카칸캐커컴컵케켜코콜콤쾌크큰클큼키킬
타탁탄탈탐탑탕태택터턱털테토톤톱통퇴투특튼틀틈티
파판팔패퍼페편평포폭표푸품풀품풍프플피필핑
하학한할함합항해핵행향허헌험헤현혁협형혜호혹혼홀홍화확환활황회획횟효후훈훌훔휘휴흉흐흑흔흘흙흡흥희흰히힘
준서연우진민현지영수호재성윤아은채윤하율온유주시우도윤건우시윤예준지호선우정우승우예성유진하준서진도현
"""

def hangul(text):
    return set(ch for ch in text if 0xAC00 <= ord(ch) <= 0xD7A3)

def collect_tier1():
    chars = hangul(COMMON)
    # 사이트가 실제로 쓰는 글자
    for rel in ("index.html", "app.js"):
        p = os.path.join(ROOT, rel)
        if os.path.exists(p):
            chars |= hangul(open(p, encoding="utf-8").read())
    # 급식·학사일정 등에서 미리 수집해 둔 글자
    extra = os.path.join(ROOT, "tools", "extra-chars.txt")
    if os.path.exists(extra):
        chars |= hangul(open(extra, encoding="utf-8").read())
    return chars

def ks_x_1001():
    out = set()
    for c in range(0xAC00, 0xD7A4):
        try:
            chr(c).encode("iso2022_kr"); out.add(chr(c))
        except Exception:
            pass
    return out

LATIN = set(chr(c) for c in range(0x20, 0x7F))
PUNCT = set("　·…—–‘’“”※℃±×÷→←↑↓♥★☆○●◎◆■□▲▼♪✓∼~€₩°")
JAMO  = set(chr(c) for c in range(0x3131, 0x3164))

def ranges(chars):
    cps = sorted(ord(c) for c in chars)
    out, s, p = [], cps[0], cps[0]
    for c in cps[1:]:
        if c == p + 1:
            p = c; continue
        out.append((s, p)); s = p = c
    out.append((s, p))
    return ",".join(f"U+{a:04X}" if a == b else f"U+{a:04X}-{b:04X}" for a, b in out)

def subset(src, unicodes, out_path):
    f = TTFont(os.path.join(SRC_DIR, src))
    o = Options()
    o.flavor = "woff2"; o.hinting = False
    o.drop_tables += ["DSIG", "kern", "LTSH", "VDMX", "hdmx", "gasp"]
    o.name_IDs = [1, 2, 3, 4, 6]; o.notdef_outline = True
    Subsetter(options=o).subset_and_save = None  # noqa (명시용)
    s = Subsetter(options=o); s.populate(unicodes=unicodes); s.subset(f)
    f.save(out_path); f.close()
    return os.path.getsize(out_path) / 1024

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    ks = ks_x_1001()
    t1 = (collect_tier1() & ks) | LATIN | PUNCT | JAMO
    t2 = ks - t1
    T1 = sorted(ord(c) for c in t1)
    T2 = sorted(ord(c) for c in t2)
    R1, R2 = ranges(t1), ranges(t2)
    print(f"1단계 {len(T1):,}자 / 2단계 {len(T2):,}자")

    # 이전 생성물 정리
    for old in os.listdir(OUT_DIR):
        if old.endswith(".woff2"):
            os.remove(os.path.join(OUT_DIR, old))

    css = ["""/* ============================================================
   강원교육 글꼴 (강원특별자치도교육청 무료 배포 글꼴)
   ※ tools/build-fonts.py 로 생성된 파일입니다. 직접 고치지 마세요.
   1단계: 자주 쓰는 글자 (즉시 로드) / 2단계: 드문 글자 (필요할 때만)
   ============================================================ */"""]
    total1 = 0
    for fam, weight, src, tier2 in FACES:
        stem = fam.lower().replace("gangwon", "")
        p1 = os.path.join(OUT_DIR, f"{stem}-1.woff2")
        kb1 = subset(src, T1, p1); total1 += kb1
        css.append(f"""@font-face {{
  font-family: '{fam}';
  src: url('fonts/{stem}-1.woff2') format('woff2');
  font-weight: {weight}; font-style: normal; font-display: swap;
  unicode-range: {R1};
}}""")
        line = f"  {fam}: 1단계 {kb1:,.0f}KB"
        if tier2:
            p2 = os.path.join(OUT_DIR, f"{stem}-2.woff2")
            kb2 = subset(src, T2, p2)
            css.append(f"""@font-face {{
  font-family: '{fam}';
  src: url('fonts/{stem}-2.woff2') format('woff2');
  font-weight: {weight}; font-style: normal; font-display: swap;
  unicode-range: {R2};
}}""")
            line += f" + 2단계 {kb2:,.0f}KB"
        print(line)
    open(os.path.join(ROOT, "fonts.css"), "w", encoding="utf-8").write("\n".join(css) + "\n")
    print(f"1단계 합계 {total1:,.0f}KB  → fonts.css 생성 완료")

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
