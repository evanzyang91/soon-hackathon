// Join: host + room code (typed, or from the laptop's QR), certificate pairing confirmation.
import PrevizCore
import SwiftUI

struct JoinView: View {
  @Bindable var model: AppModel
  @State private var scanning = false
  @State private var scanError: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Button {
            scanError = nil
            scanning = true
          } label: {
            Label("Scan the laptop's QR code", systemImage: "qrcode.viewfinder")
          }
        } footer: {
          Text("The laptop shows a QR code and room code for the phone. Use the same Wi-Fi as the laptop.")
        }

        Section("Or type it") {
          TextField("Laptop address, e.g. 192.168.1.20:5173", text: $model.hostInput)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Room code", text: $model.roomInput)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .font(.body.monospaced())
        }

        Section {
          Button {
            Task { await model.join() }
          } label: {
            HStack {
              Text("Join")
              Spacer()
              if model.isJoining { ProgressView() }
            }
          }
          .disabled(model.isJoining || model.hostInput.isEmpty)
        } footer: {
          if let error = model.joinError ?? scanError {
            Text(error).foregroundStyle(.red)
          } else if !ARTracker.isSupported {
            Text("This device does not support ARKit world tracking.").foregroundStyle(.red)
          }
        }
      }
      .navigationTitle("Previz Camera")
      .sheet(isPresented: $scanning) {
        NavigationStack {
          QRScannerView(
            onCode: { text in
              scanning = false
              if model.useScanned(text) {
                Task { await model.join() }
              } else {
                scanError = "That QR code is not a Previz phone link (…/phone.html?room=…)."
              }
            },
            onFailure: { message in
              scanning = false
              scanError = message
            }
          )
          .ignoresSafeArea()
          .navigationTitle("Scan")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } }
          }
        }
      }
      .alert(
        model.pendingTrust?.changed == true ? "Certificate changed" : "Trust this laptop?",
        isPresented: Binding(get: { model.pendingTrust != nil }, set: { if !$0 { model.pendingTrust = nil } }),
        presenting: model.pendingTrust
      ) { pending in
        Button("Trust") { model.confirmTrust(pending) }
        Button("Cancel", role: .cancel) { model.pendingTrust = nil }
      } message: { pending in
        Text(
          """
          \(pending.changed ? "The certificate for \(pending.target.hostPort) is not the one you trusted before (the laptop makes a new one when its network changes).\n\n" : "")SHA-256 \(pending.fingerprint)

          It should match the laptop's: openssl x509 -noout -fingerprint -sha256 -in certs/cert.pem
          """)
      }
    }
  }
}
