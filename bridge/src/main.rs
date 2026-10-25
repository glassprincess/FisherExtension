//! Native Messaging мост: расширение Firefox <-> stockfish.exe (UCI).
//!
//! Протокол браузера: 4 байта длины (порядок байт платформы) + JSON UTF-8.
//! Запрос:   {"id":N,"moves":["e2e4",...],"mode":"time|depth|nodes","value":X,"skill":0..20}
//! Старый формат {"id":N,"moves":[...],"movetime":MS} тоже принимается.
//! Ответы:   {"type":"ready"}  |  {"id":N,"bestmove":"e2e4"}  |  {"id":N,"error":"..."}
//!
//! Безопасность: в движок уходят только проверенные токены ходов (a1a1[qrbn]), режим,
//! целые числа и Skill Level, поэтому внедрить произвольную UCI-команду через сообщение нельзя.
//! Мост не открывает сетевых портов; доступ к нему задаёт allowed_extensions в манифесте хоста.

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc::channel;
use std::thread;

const MAX_MSG: usize = 1_048_576;
const MAX_MOVES: usize = 1024;
/// Верхняя граница movetime — защита от опечаток; это не рекомендация по уровням.
const MAX_MOVETIME_MS: u64 = 60_000;
const MAX_DEPTH: u32 = 30;
const MAX_NODES: u64 = 1_000_000_000;
const MAX_SKILL: u8 = 20;

// ───────────────────────── минимальный JSON ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(s: &'a [u8]) -> Self {
        Parser { s, i: 0 }
    }

    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn expect(&mut self, c: u8) -> Result<(), String> {
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("ожидался символ '{}'", c as char))
        }
    }

    fn lit(&mut self, word: &str, val: Json) -> Result<Json, String> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(val)
        } else {
            Err("неверный литерал".to_string())
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = match self.peek() {
                Some(c) => c,
                None => return Err("строка не закрыта".to_string()),
            };
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = match self.peek() {
                        Some(e) => e,
                        None => return Err("обрыв экранирования".to_string()),
                    };
                    self.i += 1;
                    match e {
                        b'"' | b'\\' | b'/' => out.push(e),
                        _ => return Err("неподдерживаемое экранирование".to_string()),
                    }
                }
                0..=0x1f => return Err("управляющий символ в строке".to_string()),
                _ => out.push(c),
            }
        }
        String::from_utf8(out).map_err(|_| "строка не в UTF-8".to_string())
    }

    fn value(&mut self, depth: u32) -> Result<Json, String> {
        if depth > 16 {
            return Err("слишком глубокая вложенность".to_string());
        }
        self.ws();
        match self.peek() {
            None => Err("неожиданный конец данных".to_string()),
            Some(b'{') => {
                self.i += 1;
                let mut items: Vec<(String, Json)> = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(Json::Obj(items));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.ws();
                    self.expect(b':')?;
                    let v = self.value(depth + 1)?;
                    items.push((k, v));
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            break;
                        }
                        _ => return Err("неверный объект".to_string()),
                    }
                }
                Ok(Json::Obj(items))
            }
            Some(b'[') => {
                self.i += 1;
                let mut items: Vec<Json> = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                loop {
                    let v = self.value(depth + 1)?;
                    items.push(v);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            break;
                        }
                        _ => return Err("неверный массив".to_string()),
                    }
                }
                Ok(Json::Arr(items))
            }
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.lit("true", Json::Bool(true)),
            Some(b'f') => self.lit("false", Json::Bool(false)),
            Some(b'n') => self.lit("null", Json::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => {
                let start = self.i;
                while let Some(d) = self.peek() {
                    if d.is_ascii_digit() || matches!(d, b'-' | b'+' | b'.' | b'e' | b'E') {
                        self.i += 1;
                    } else {
                        break;
                    }
                }
                let t = match std::str::from_utf8(&self.s[start..self.i]) {
                    Ok(t) => t,
                    Err(_) => return Err("неверное число".to_string()),
                };
                match t.parse::<f64>() {
                    Ok(n) => Ok(Json::Num(n)),
                    Err(_) => Err("неверное число".to_string()),
                }
            }
            Some(_) => Err("неожиданный символ".to_string()),
        }
    }
}

fn parse_json(buf: &[u8]) -> Result<Json, String> {
    let mut p = Parser::new(buf);
    let v = p.value(0)?;
    p.ws();
    if p.i != buf.len() {
        return Err("лишние данные после JSON".to_string());
    }
    Ok(v)
}

fn get<'a>(obj: &'a [(String, Json)], key: &str) -> Option<&'a Json> {
    obj.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn int_value(v: Option<&Json>, name: &str, min: u64, max: u64) -> Result<u64, String> {
    match v {
        Some(Json::Num(n)) if n.is_finite() && n.fract() == 0.0 && *n >= min as f64 && *n <= max as f64 => Ok(*n as u64),
        _ => Err(format!("{} должен быть целым от {} до {}", name, min, max)),
    }
}

// ───────────────────────── запросы ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Limit {
    Time(u64),
    Depth(u32),
    Nodes(u64),
}

#[derive(Debug, Clone, PartialEq)]
struct Request {
    id: i64,
    moves: Vec<String>,
    limit: Limit,
    skill: Option<u8>,
}

fn valid_uci_move(m: &str) -> bool {
    let b = m.as_bytes();
    if b.len() != 4 && b.len() != 5 {
        return false;
    }
    let file = |c: u8| (b'a'..=b'h').contains(&c);
    let rank = |c: u8| (b'1'..=b'8').contains(&c);
    if !(file(b[0]) && rank(b[1]) && file(b[2]) && rank(b[3])) {
        return false;
    }
    b.len() == 4 || matches!(b[4], b'q' | b'r' | b'b' | b'n')
}

/// Ошибка содержит id (если удалось его прочитать, иначе 0) и текст.
fn parse_request(buf: &[u8]) -> Result<Request, (i64, String)> {
    let json = parse_json(buf).map_err(|e| (0i64, format!("некорректный JSON: {}", e)))?;
    let obj = match &json {
        Json::Obj(o) => o,
        _ => return Err((0, "ожидался объект".to_string())),
    };
    let id = match get(obj, "id") {
        Some(Json::Num(n)) if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 => *n as i64,
        _ => return Err((0, "нет корректного поля id".to_string())),
    };
    let moves_json = match get(obj, "moves") {
        Some(Json::Arr(a)) => a,
        _ => return Err((id, "нет массива moves".to_string())),
    };
    if moves_json.len() > MAX_MOVES {
        return Err((id, "слишком много ходов".to_string()));
    }
    let mut moves = Vec::with_capacity(moves_json.len());
    for m in moves_json {
        match m {
            Json::Str(s) if valid_uci_move(s) => moves.push(s.clone()),
            _ => return Err((id, "недопустимый ход в moves".to_string())),
        }
    }
    let mode = match get(obj, "mode") {
        Some(Json::Str(s)) => Some(s.as_str()),
        None => None,
        Some(_) => return Err((id, "mode должен быть строкой".to_string())),
    };
    let skill = match get(obj, "skill") {
        Some(Json::Num(n)) if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= MAX_SKILL as f64 => Some(*n as u8),
        None | Some(Json::Null) => None,
        _ => return Err((id, "skill должен быть целым от 0 до 20".to_string())),
    };
    let limit = match mode {
        Some("depth") => Limit::Depth(int_value(get(obj, "value"), "value (depth)", 1, MAX_DEPTH as u64)
            .map_err(|e| (id, e))? as u32),
        Some("nodes") => Limit::Nodes(int_value(get(obj, "value"), "value (nodes)", 1, MAX_NODES)
            .map_err(|e| (id, e))?),
        Some("time") | None => {
            let value = if get(obj, "value").is_some() { get(obj, "value") } else { get(obj, "movetime") };
            Limit::Time(int_value(value, "value/movetime", 1, MAX_MOVETIME_MS).map_err(|e| (id, e))?)
        }
        Some(_) => return Err((id, "неизвестный режим; ожидается time, depth или nodes".to_string())),
    };
    Ok(Request { id, moves, limit, skill })
}

// ───────────────────────── вывод ─────────────────────────

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

fn reply_err(id: i64, msg: &str) -> String {
    format!("{{\"id\":{},\"error\":\"{}\"}}", id, json_escape(msg))
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Score {
    mate: bool,
    value: i64,
}

/// Разбирает строку `info ... depth N ... score cp X|mate Y ...`.
/// Оценка — от лица того, чей ход; остальные поля игнорируются.
fn parse_score(line: &str) -> Option<(u32, Score)> {
    let mut it = line.split_whitespace();
    let mut depth = 0u32;
    let mut score = None;
    while let Some(tok) = it.next() {
        match tok {
            "depth" => {
                if let Some(n) = it.next().and_then(|s| s.parse::<u32>().ok()) {
                    depth = n;
                }
            }
            "score" => {
                let kind = it.next()?;
                let value = it.next()?.parse::<i64>().ok()?;
                score = match kind {
                    "cp" => Some((false, value)),
                    "mate" => Some((true, value)),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    score.map(|(mate, value)| (depth, Score { mate, value }))
}

fn reply_best(id: i64, mv: &str, eval: Option<(u32, Score)>) -> String {
    match eval {
        None => format!("{{\"id\":{},\"bestmove\":\"{}\"}}", id, mv),
        Some((depth, s)) => format!(
            "{{\"id\":{},\"bestmove\":\"{}\",\"depth\":{},\"eval\":{{\"type\":\"{}\",\"value\":{}}}}}",
            id,
            mv,
            depth,
            if s.mate { "mate" } else { "cp" },
            s.value
        ),
    }
}

fn write_msg(s: &str) -> io::Result<()> {
    let b = s.as_bytes();
    let mut buf = Vec::with_capacity(4 + b.len());
    buf.extend_from_slice(&(b.len() as u32).to_ne_bytes());
    buf.extend_from_slice(b);
    let out = io::stdout();
    let mut lock = out.lock();
    lock.write_all(&buf)?;
    lock.flush()
}

fn read_message<R: Read>(r: &mut R) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).ok()?;
    let n = u32::from_ne_bytes(len) as usize;
    if n == 0 || n > MAX_MSG {
        return None;
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).ok()?;
    Some(buf)
}

// ───────────────────────── движок ─────────────────────────

enum Event {
    Browser(Request),
    BrowserClosed,
    EngineLine(String),
    EngineClosed,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// engine_path.txt (первая строка) переопределяет путь; иначе stockfish.exe рядом с мостом,
/// затем ../engine/stockfish.exe (обычная раскладка проекта: bin/ + engine/).
fn engine_path(dir: &Path) -> PathBuf {
    if let Ok(text) = fs::read_to_string(dir.join("engine_path.txt")) {
        let line = text.lines().next().unwrap_or("").trim().to_string();
        if !line.is_empty() {
            return PathBuf::from(line);
        }
    }
    let name = if cfg!(windows) { "stockfish.exe" } else { "stockfish" };
    let local = dir.join(name);
    if local.is_file() {
        return local;
    }
    if let Some(parent) = dir.parent() {
        let bundled = parent.join("engine").join(name);
        if bundled.is_file() {
            return bundled;
        }
    }
    local
}

fn option_name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ' ')
}

fn option_value_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ' '))
}

/// engine_options.txt: строки вида `Threads=4`. Некорректные строки пропускаются.
fn read_options(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(text) = fs::read_to_string(dir.join("engine_options.txt")) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let (k, v) = (k.trim(), v.trim());
                if option_name_ok(k) && option_value_ok(v) {
                    out.push(format!("setoption name {} value {}\n", k, v));
                }
            }
        }
    }
    out
}

fn send_engine(ein: &mut ChildStdin, text: &str) -> bool {
    ein.write_all(text.as_bytes()).and_then(|_| ein.flush()).is_ok()
}

fn search_commands(r: &Request) -> String {
    let mut out = String::new();
    if let Some(skill) = r.skill {
        out.push_str(&format!("setoption name Skill Level value {}\n", skill));
    }
    if r.moves.is_empty() {
        out.push_str("position startpos\n");
    } else {
        out.push_str(&format!("position startpos moves {}\n", r.moves.join(" ")));
    }
    match r.limit {
        Limit::Time(ms) => out.push_str(&format!("go movetime {}\n", ms)),
        Limit::Depth(d) => out.push_str(&format!("go depth {}\n", d)),
        Limit::Nodes(n) => out.push_str(&format!("go nodes {}\n", n)),
    }
    out
}

fn start_search(ein: &mut ChildStdin, r: &Request) -> bool {
    send_engine(ein, &search_commands(r))
}

fn main() {
    let dir = exe_dir();
    let path = engine_path(&dir);

    let mut cmd = Command::new(&path);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(parent) = path.parent() {
        if parent.is_dir() {
            cmd.current_dir(parent);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = write_msg(&reply_err(0, &format!("не удалось запустить движок {}: {}", path.display(), e)));
            std::process::exit(1);
        }
    };
    let mut ein = child.stdin.take().expect("stdin движка");
    let eout = child.stdout.take().expect("stdout движка");

    let (tx, rx) = channel::<Event>();

    let tx_e = tx.clone();
    thread::spawn(move || {
        for line in BufReader::new(eout).lines() {
            match line {
                Ok(l) => {
                    if tx_e.send(Event::EngineLine(l)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx_e.send(Event::EngineClosed);
    });

    let tx_b = tx.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin();
        loop {
            match read_message(&mut stdin) {
                None => {
                    let _ = tx_b.send(Event::BrowserClosed);
                    break;
                }
                Some(buf) => match parse_request(&buf) {
                    Ok(r) => {
                        if tx_b.send(Event::Browser(r)).is_err() {
                            break;
                        }
                    }
                    Err((id, m)) => {
                        let _ = write_msg(&reply_err(id, &m));
                    }
                },
            }
        }
    });

    if !send_engine(&mut ein, "uci\n") {
        let _ = write_msg(&reply_err(0, "движок не принимает команды"));
        std::process::exit(1);
    }

    // 0 — ждём uciok, 1 — ждём readyok, 2 — готов
    let mut stage = 0;
    let mut searching: Option<i64> = None;
    let mut last_score: Option<(u32, Score)> = None;
    let mut stop_sent = false;
    let mut pending: Option<Request> = None;

    while let Ok(ev) = rx.recv() {
        match ev {
            Event::Browser(req) => {
                if stage < 2 {
                    pending = Some(req);
                } else if searching.is_some() {
                    pending = Some(req);
                    if !stop_sent {
                        stop_sent = true;
                        if !send_engine(&mut ein, "stop\n") {
                            break;
                        }
                    }
                } else {
                    searching = Some(req.id);
                    last_score = None;
                    if !start_search(&mut ein, &req) {
                        break;
                    }
                }
            }
            Event::EngineLine(line) => {
                let line = line.trim();
                if stage == 0 && line == "uciok" {
                    for o in read_options(&dir) {
                        if !send_engine(&mut ein, &o) {
                            break;
                        }
                    }
                    if !send_engine(&mut ein, "isready\n") {
                        break;
                    }
                    stage = 1;
                } else if stage == 1 && line == "readyok" {
                    stage = 2;
                    let _ = write_msg("{\"type\":\"ready\"}");
                    if let Some(req) = pending.take() {
                        searching = Some(req.id);
                        last_score = None;
                        if !start_search(&mut ein, &req) {
                            break;
                        }
                    }
                } else if stage == 2 && line.starts_with("info ") {
                    if let Some(s) = parse_score(line) {
                        last_score = Some(s);
                    }
                } else if stage == 2 && line.starts_with("bestmove") {
                    if let Some(id) = searching.take() {
                        let eval = last_score.take();
                        if stop_sent {
                            stop_sent = false; // результат остановленного поиска отбрасываем
                        } else {
                            let mv = line.split_whitespace().nth(1).unwrap_or("");
                            if valid_uci_move(mv) {
                                let _ = write_msg(&reply_best(id, mv, eval));
                            } else {
                                let _ = write_msg(&reply_err(id, "ходов нет"));
                            }
                        }
                        if let Some(req) = pending.take() {
                            searching = Some(req.id);
                            last_score = None;
                            if !start_search(&mut ein, &req) {
                                break;
                            }
                        }
                    }
                }
            }
            Event::BrowserClosed => break,
            Event::EngineClosed => {
                let _ = write_msg(&reply_err(0, "процесс движка завершился"));
                break;
            }
        }
    }

    let _ = send_engine(&mut ein, "quit\n");
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_request() {
        let r = parse_request(br#"{"id":7,"moves":["e2e4","e7e5","a7a8q"],"mode":"time","value":200,"skill":10}"#).unwrap();
        assert_eq!(r, Request {
            id: 7,
            moves: vec!["e2e4".into(), "e7e5".into(), "a7a8q".into()],
            limit: Limit::Time(200),
            skill: Some(10),
        });
        let legacy = parse_request(br#"{"id":8,"moves":[],"movetime":1000}"#).unwrap();
        assert_eq!(legacy.limit, Limit::Time(1000));
        assert_eq!(legacy.skill, None);
        let depth = parse_request(br#"{"id":9,"moves":[],"mode":"depth","value":15,"skill":20}"#).unwrap();
        assert_eq!(depth.limit, Limit::Depth(15));
        assert_eq!(depth.skill, Some(20));
        let nodes = parse_request(br#"{"id":10,"moves":[],"mode":"nodes","value":100000,"skill":0}"#).unwrap();
        assert_eq!(nodes.limit, Limit::Nodes(100000));
        assert_eq!(nodes.skill, Some(0));
    }

    #[test]
    fn rejects_injection_and_bad_values() {
        assert!(parse_request(br#"{"id":1,"moves":["e2e4\nquit"],"movetime":200}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":["e2e4 go infinite"],"movetime":200}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"movetime":0}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"movetime":60001}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"movetime":1.5}"#).is_err());
        assert!(parse_request(br#"{"moves":[],"movetime":10}"#).is_err());
        assert!(parse_request(b"not json").is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"movetime":10} x"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"depth","value":0}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"depth","value":31}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"nodes","value":0}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"nodes","value":1000000001}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"time","value":0}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"time","value":60001}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"depth","value":5,"skill":21}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"depth","value":5,"skill":-1}"#).is_err());
        assert!(parse_request(br#"{"id":1,"moves":[],"mode":"wat","value":5}"#).is_err());
    }

    #[test]
    fn build_search_commands() {
        let r = parse_request(br#"{"id":1,"moves":["e2e4"],"mode":"depth","value":12,"skill":5}"#).unwrap();
        assert_eq!(search_commands(&r),
            "setoption name Skill Level value 5\nposition startpos moves e2e4\ngo depth 12\n");
        let nodes = parse_request(br#"{"id":2,"moves":[],"mode":"nodes","value":100000}"#).unwrap();
        assert_eq!(search_commands(&nodes), "position startpos\ngo nodes 100000\n");
        let legacy = parse_request(br#"{"id":3,"moves":[],"movetime":200}"#).unwrap();
        assert_eq!(search_commands(&legacy), "position startpos\ngo movetime 200\n");
    }

    #[test]
    fn empty_moves_ok() {
        assert!(parse_request(br#"{"id":2,"moves":[],"movetime":1000}"#).is_ok());
    }

    #[test]
    fn move_validation() {
        assert!(valid_uci_move("e2e4"));
        assert!(valid_uci_move("e7e8q"));
        assert!(!valid_uci_move("e7e8k"));
        assert!(!valid_uci_move("i2e4"));
        assert!(!valid_uci_move("e9e4"));
        assert!(!valid_uci_move("(none)"));
    }

    #[test]
    fn option_validation() {
        assert!(option_name_ok("Threads") && option_value_ok("4"));
        assert!(!option_name_ok("Threads\nquit") && !option_value_ok("4\nquit"));
    }

    #[test]
    fn parses_engine_score() {
        assert_eq!(
            parse_score("info depth 18 seldepth 25 multipv 1 score cp 35 nodes 123 pv e2e4 e7e5"),
            Some((18, Score { mate: false, value: 35 }))
        );
        assert_eq!(
            parse_score("info depth 12 score mate -2 pv e2e4"),
            Some((12, Score { mate: true, value: -2 }))
        );
        assert_eq!(
            parse_score("info depth 5 score cp 20 upperbound nodes 900"),
            Some((5, Score { mate: false, value: 20 }))
        );
        assert_eq!(parse_score("info depth 3 currmove e2e4"), None);
        assert_eq!(parse_score("info score cp nope"), None);
        assert_eq!(parse_score("bestmove e2e4"), None);
    }

    #[test]
    fn reply_includes_eval() {
        assert_eq!(reply_best(7, "e2e4", None), "{\"id\":7,\"bestmove\":\"e2e4\"}");
        assert_eq!(
            reply_best(7, "e2e4", Some((18, Score { mate: false, value: 35 }))),
            "{\"id\":7,\"bestmove\":\"e2e4\",\"depth\":18,\"eval\":{\"type\":\"cp\",\"value\":35}}"
        );
        assert_eq!(
            reply_best(8, "d1h5", Some((9, Score { mate: true, value: 3 }))),
            "{\"id\":8,\"bestmove\":\"d1h5\",\"depth\":9,\"eval\":{\"type\":\"mate\",\"value\":3}}"
        );
    }

    #[test]
    fn engine_lookup_uses_project_engine_dir() {
        let base = std::env::temp_dir().join(format!("cbh-engine-path-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let bin = base.join("bin");
        let engine = base.join("engine");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&engine).unwrap();
        let name = if cfg!(windows) { "stockfish.exe" } else { "stockfish" };
        fs::write(engine.join(name), b"project").unwrap();
        assert_eq!(engine_path(&bin), engine.join(name));
        fs::write(bin.join(name), b"local").unwrap();
        assert_eq!(engine_path(&bin), bin.join(name));
        let _ = fs::remove_dir_all(&base);
    }
}
