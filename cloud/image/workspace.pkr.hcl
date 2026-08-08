packer {
  required_version = ">= 1.10.0"
  required_plugins {
    oracle = {
      source  = "github.com/hashicorp/oracle"
      version = "~> 1.1"
    }
  }
}

variable "region" {
  type = string
}

variable "availability_domain" {
  type = string
}

variable "compartment_ocid" {
  type = string
}

variable "subnet_ocid" {
  type = string
}

variable "base_image_ocid" {
  type = string
}

variable "oci_config_file" {
  type = string
}

variable "oci_profile" {
  type = string
}

variable "shape" {
  type = string
}

variable "ocpus" {
  type = number
}

variable "memory_in_gbs" {
  type = number
}

variable "ssh_username" {
  type = string
}

variable "image_name" {
  type = string
}

variable "gbrain_git_sha" {
  type = string
}

variable "source_archive" {
  type = string
}

variable "image_bundle_archive" {
  type = string
}

variable "manifest_path" {
  type = string
}

source "oracle-oci" "workspace" {
  access_cfg_file         = var.oci_config_file
  access_cfg_file_account = var.oci_profile
  region                  = var.region
  availability_domain     = var.availability_domain
  compartment_ocid        = var.compartment_ocid
  subnet_ocid             = var.subnet_ocid
  base_image_ocid         = var.base_image_ocid
  image_name              = var.image_name
  instance_name           = "packer-${var.image_name}"
  shape                   = var.shape
  ssh_username            = var.ssh_username

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  instance_options_are_legacy_imds_endpoints_disabled = true
  tags = {
    "2brain-component" = "workspace-image"
    "gbrain-git-sha"   = var.gbrain_git_sha
  }
  instance_tags = {
    "2brain-purpose" = "packer-build"
  }
}

build {
  name    = "2brain-workspace"
  sources = ["source.oracle-oci.workspace"]

  provisioner "file" {
    source      = var.source_archive
    destination = "/tmp/gbrain-source.tar.gz"
  }

  provisioner "file" {
    source      = var.image_bundle_archive
    destination = "/tmp/gbrain-image-bundle.tar.gz"
  }

  provisioner "shell" {
    inline = [
      "sudo install -d -m 0755 /opt/gbrain-image",
      "sudo tar -xzf /tmp/gbrain-image-bundle.tar.gz -C /opt/gbrain-image",
      "sudo /opt/gbrain-image/scripts/provision.sh /tmp/gbrain-source.tar.gz /opt/gbrain-image",
    ]
  }

  post-processor "manifest" {
    output     = var.manifest_path
    strip_path = true
    custom_data = {
      gbrain_git_sha = var.gbrain_git_sha
      image_name     = var.image_name
    }
  }
}
