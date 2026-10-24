import Foundation
import Testing

@testable import PrevizCore

@Suite("Join links")
struct JoinLinkTests {
  @Test func parsesTheLaptopQR() throws {
    let t = try #require(JoinLink.parse("https://192.168.1.20:5173/phone.html?room=ABCD"))
    #expect(t == JoinTarget(host: "192.168.1.20", port: 5173, room: "ABCD"))
    #expect(t.webSocketURL.absoluteString == "wss://192.168.1.20:5173/ws")
    #expect(t.certificateURL.absoluteString == "https://192.168.1.20:5173/cert.pem")
    #expect(t.hostPort == "192.168.1.20:5173")
    #expect(
      t.pageURL().absoluteString
        == "https://192.168.1.20:5173/phone.html?room=ABCD&pose=external&voice=0&sim=0")
  }

  @Test func roomCodesNormalise() {
    #expect(JoinLink.normalizeRoom(" abcd ") == "ABCD")
    #expect(JoinLink.normalizeRoom("ab12c9") == "AB12C9")
    #expect(JoinLink.normalizeRoom("abc") == nil)
    #expect(JoinLink.normalizeRoom("abcdefg") == nil)
    #expect(JoinLink.normalizeRoom("ab-d") == nil)
    #expect(JoinLink.normalizeRoom("ÄBCD") == nil)
    #expect(JoinLink.parse("https://10.0.0.5:5173/phone.html?room=wxyz")?.room == "WXYZ")
    #expect(JoinLink.parse("https://10.0.0.5:5173/phone.html?room=no") == nil)
    #expect(JoinLink.parse("https://10.0.0.5:5173/phone.html") == nil)
    #expect(JoinLink.parse("10.0.0.5:5173") == nil)  // not a URL: no room either
  }

  @Test func hostInputs() {
    #expect(JoinLink.parseHost("192.168.1.20:5173")! == ("192.168.1.20", 5173))
    #expect(JoinLink.parseHost(" 192.168.1.20 ")! == ("192.168.1.20", 5173))
    #expect(JoinLink.parseHost("Evans-MBP.local:8443")! == ("evans-mbp.local", 8443))
    #expect(JoinLink.parseHost("https://10.0.0.2/")! == ("10.0.0.2", 5173))
    #expect(JoinLink.parseHost("") == nil)
    #expect(JoinLink.parseHost("host:99999") == nil)
  }

  @Test func targetFromFields() {
    #expect(JoinLink.target(host: "192.168.1.20", room: "abcd") == JoinTarget(host: "192.168.1.20", room: "ABCD"))
    // a pasted phone URL in the host field wins, room included
    #expect(
      JoinLink.target(host: "https://192.168.1.9:5173/phone.html?room=QRST", room: "")
        == JoinTarget(host: "192.168.1.9", room: "QRST"))
    #expect(JoinLink.target(host: "192.168.1.20", room: "x") == nil)
  }

  @Test func resolvesManifestUrls() {
    let t = JoinTarget(host: "192.168.1.20", room: "ABCD")
    #expect(
      t.resolve("/projects/p/scene-0/manifest.json")?.absoluteString
        == "https://192.168.1.20:5173/projects/p/scene-0/manifest.json")
    #expect(
      t.resolve("https://10.1.1.1:5173/projects/p/scene-0/manifest.json")?.absoluteString
        == "https://10.1.1.1:5173/projects/p/scene-0/manifest.json")
  }

  @Test func ipv6Hosts() throws {
    let t = try #require(JoinLink.parse("https://[fe80::1]:5173/phone.html?room=ABCD"))
    #expect(t.host == "fe80::1")
    #expect(t.hostPort == "[fe80::1]:5173")
    #expect(t.webSocketURL.absoluteString == "wss://[fe80::1]:5173/ws")
  }
}
