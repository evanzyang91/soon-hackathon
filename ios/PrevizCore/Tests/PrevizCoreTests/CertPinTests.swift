import Foundation
import Testing

@testable import PrevizCore

/// `openssl x509 -in Fixtures/test-cert.pem -noout -fingerprint -sha256`
private let fixtureFingerprint =
  "3E:19:E7:DD:D8:03:09:B5:F7:0F:4D:F5:EC:DC:B0:77:FC:EC:1F:D4:D5:94:B9:98:73:3A:89:EB:BD:61:B3:29"

private func fixturePEM() throws -> String {
  let url = try #require(Bundle.module.url(forResource: "test-cert", withExtension: "pem", subdirectory: "Fixtures"))
  return try String(contentsOf: url, encoding: .utf8)
}

@Suite("Certificate pins")
struct CertPinTests {
  @Test func fingerprintMatchesOpenSSL() throws {
    let ders = CertPin.derCertificates(fromPEM: try fixturePEM())
    #expect(ders.count == 1)
    let hex = CertPin.sha256Hex(ders[0])
    #expect(hex.count == 64)
    #expect(CertPin.displayFingerprint(hex) == fixtureFingerprint)
  }

  @Test func pemParsingCopesWithChainsAndCRLF() throws {
    let pem = try fixturePEM()
    let chain = (pem + "\n" + pem).replacingOccurrences(of: "\n", with: "\r\n")
    #expect(CertPin.derCertificates(fromPEM: chain).count == 2)
    #expect(CertPin.derCertificates(fromPEM: "garbage").isEmpty)
  }

  @Test func pinStoreDecisions() throws {
    let der = try #require(CertPin.derCertificates(fromPEM: try fixturePEM()).first)
    var store = PinStore()
    #expect(store.decide(leafDER: der, hostPort: "192.168.1.20:5173") == .noPin)
    store.setPin(CertPin.sha256Hex(der), for: "192.168.1.20:5173")
    #expect(store.decide(leafDER: der, hostPort: "192.168.1.20:5173") == .pinnedMatch)
    #expect(store.decide(leafDER: Data([1, 2, 3]), hostPort: "192.168.1.20:5173") == .mismatch)
    #expect(store.decide(leafDER: der, hostPort: "192.168.1.20:8443") == .noPin)  // pins are per port
    store.removePin(for: "192.168.1.20:5173")
    #expect(store.pins.isEmpty)
  }

  @Test func pairingCheck() throws {
    let pem = try fixturePEM()
    let der = try #require(CertPin.derCertificates(fromPEM: pem).first)
    #expect(checkPairing(presentedLeafDER: der, servedPEM: pem) == .matches(sha256Hex: CertPin.sha256Hex(der)))
    #expect(checkPairing(presentedLeafDER: Data([0]), servedPEM: pem) == .differs)
    #expect(checkPairing(presentedLeafDER: der, servedPEM: "<html>") == .noCertificate)
  }
}
